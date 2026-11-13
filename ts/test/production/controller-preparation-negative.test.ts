import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { FileControllerJournal } from "../../src/controller/journal.ts";
import { preparationHistory } from "../../src/controller/preparation-history.ts";
import { using } from "./controller-port-fixture.ts";
import { batches, scripts } from "./controller-rebuild-fixture.ts";
import { withPreparation } from "./controller-preparation-fixture.ts";
import { readNative, saveNative, stagedHandle } from "./controller-preparation-native.ts";

test("TypeScript rootless first retirement requires native facts while completed parent retry permits child progress", async (t) => {
  await withPreparation(t, async (k, f) => {
    await using(k, c => c.freeze("@space"));
    const { preparation: _preparation, ...ports } = k.ports;
    await assert.rejects(using({ ...k, ports }, c => c.releaseUnsent("b1", ["o2"])), /precommit native readback/);
    assert.equal(batches(k.database)[0]!.state, "frozen"); assert.equal(batches(k.database).length, 1);
    assert.equal(await using(k, c => c.releaseUnsent("b1", ["o2"])), "b2");
    const native = readNative(f.root); native.spaces["@space"]!.root = "b".repeat(64); native.spaces["@space"]!.pending = true;
    native.spaces["@space"]!.idx = 0; saveNative(f.root, native);
    assert.equal(await using(k, c => c.releaseUnsent("b1", ["o2"])), "b2");
    assert.equal(batches(k.database).length, 2); assert.equal(readNative(f.root).parks, 0); assert.equal(readNative(f.root).commits, 0);
  });
});

test("TypeScript rejects overlapping or malformed preparation ownership history on startup", async (t) => {
  for (const fault of ["version", "overlap", "unconfirmed-clear"] as const) await withPreparation(t, async (k) => {
    const batch = await using(k, c => c.freeze("@space")), identity = { version: 1, bid: batch.bid, space: batch.space, members: batch.members, digest: batch.digest };
    const entries = k.journal.entries(), rows = [{ seq: entries.length + 1, kind: "preparation_pending", ...identity, phase: "owned" },
      { seq: entries.length + 2, kind: "preparation_pending", ...identity, phase: "cleared" }];
    if (fault === "version") Object.assign(rows[0]!, { version: 2 });
    if (fault === "overlap") Object.assign(rows[1]!, { bid: "b2", phase: "owned" });
    writeFileSync(k.journal.path, [...entries, ...rows].map(row => JSON.stringify(row)).join("\n") + "\n");
    const subject = { ...k, config: { database: k.database, makeJournal: () => new FileControllerJournal(k.directory) } };
    await assert.rejects(using(subject, c => c.stage("b1")), /invalid preparation|overlapping global|without acknowledged/);
    assert.equal(batches(k.database)[0]!.state, "frozen");
  });
});

test("TypeScript stage withholds the native effect when its exact intent loses live journal access", async (t) => {
  await withPreparation(t, async (k, f) => {
    await using(k, c => c.freeze("@space")); const append = k.journal.appendEvent.bind(k.journal);
    k.journal.appendEvent = (kind, data) => { append(kind, data); if (kind === "preparation_effect" && data.phase === "intent") k.journal.down = true; };
    await assert.rejects(using(k, c => c.stage("b1")), /journal outage/);
    k.journal.down = false; k.journal.appendEvent = append;
    assert.equal(preparationHistory(k.journal.entries()).unresolved?.operation, "pending_set");
    await assert.rejects(using(k, c => c.stage("b1")), /reconciliation/);
    assert.equal(readNative(f.root).syncs, 0); assert.equal(readNative(f.root).parks, 0); assert.equal(readNative(f.root).commits, 0);
  });
});

test("TypeScript rejects changing or duplicate paginated native rows and unfinished prior pipelines before staging", async (t) => {
  for (const fault of ["changed", "duplicate", "pending-prior"] as const) await withPreparation(t, async (k, f, server) => {
    const state = readNative(f.root), space = state.spaces["@space"]!, keys = scripts(2);
    if (fault === "pending-prior") { space.root = space.chain = "b".repeat(64); space.txid = "c".repeat(64); space.idx = 0; space.pending = true; }
    else space.handles = Array.from({ length: 101 }, (_, n) => stagedHandle(`x${String(n).padStart(3, "0")}`, keys[0]!, true));
    saveNative(f.root, state); await using(k, c => c.freeze("@space"));
    server.control.transform = (path, value) => {
      if (path.includes("/handles?") && path.includes("page=2&")) {
        const page = value as { total: number; handles: { name: string }[] };
        if (fault === "changed") page.total = 102; else page.handles[0]!.name = "x000";
      } return value;
    };
    await assert.rejects(using(k, c => c.stage("b1")), /pagination|incomplete|duplicate|ahead|ambiguous/);
    assert.equal(readNative(f.root).syncs, 0); assert.equal(readNative(f.root).parks, 0); assert.equal(readNative(f.root).commits, 0);
  });
});

test("TypeScript accepts the pinned finalized-but-unpublished pipeline before staging", async (t) => {
  await withPreparation(t, async (k, f, server) => {
    const state = readNative(f.root), space = state.spaces["@space"]!;
    space.root = space.chain = "b".repeat(64); space.txid = "c".repeat(64); space.idx = 0; space.pending = false;
    saveNative(f.root, state);
    // subs 4dcc923 core/src/app.rs: finalized, published_at=None. The pending
    // flag follows the upstream expression; it is not a publication flag.
    server.control.transform = (path, value) => path.endsWith("/pipeline") ? {
      ...(value as object), has_pending: false, current_step: "published", unpublished: 1,
      steps: { local: "complete", proving: "skipped", broadcast: "complete", confirmed: "complete", finalized: "complete", published: "in_progress" },
    } : value;
    await using(k, c => c.freeze("@space"));
    assert.equal((await using(k, c => c.stage("b1"))).state, "staged");
    assert.equal(readNative(f.root).syncs, 1);
  });
});

test("TypeScript preflight admits exact committed-page capacity and refuses overflow before commit intent", async (t) => {
  for (const count of [9999, 10000]) await withPreparation(t, async (k, f) => {
    const state = readNative(f.root), space = state.spaces["@space"]!, key = scripts(1)[0]!;
    space.chain = space.root = "b".repeat(64); space.txid = "c".repeat(64); space.idx = 0;
    space.handles = Array.from({ length: count }, (_, n) => ({ ...stagedHandle(`old${String(n).padStart(5, "0")}`, key), status: "committed" as const,
      commitment_root: space.root, commitment_idx: 0 })); saveNative(f.root, state);
    await using(k, c => c.freeze("@space", ["o1"])); await using(k, c => c.stage("b1"));
    if (count === 9999) assert.equal((await using(k, c => c.commitLocal("b1"))).state, "committed_local");
    else { await assert.rejects(using(k, c => c.commitLocal("b1")), /capacity exceeded/); assert.equal(k.journal.entries().filter(e => e.kind === "commit_local_intent").length, 0); }
    assert.equal(readNative(f.root).commits, count === 9999 ? 1 : 0);
  });
});

test("TypeScript full committed-root readback detects extra members and mismatched replies without a second commit", async (t) => {
  for (const fault of ["extra-member", "wrong-script", "boolean-count"] as const) await withPreparation(t, async (k, f, server) => {
    await using(k, c => c.freeze("@space")); await using(k, c => c.stage("b1"));
    server.control.after = path => {
      if (!path.endsWith("/commit") || fault === "boolean-count") return;
      const state = readNative(f.root), space = state.spaces["@space"]!;
      if (fault === "extra-member") space.handles.push({ ...space.handles[0]!, name: "foreign" });
      else space.handles[0]!.script_pubkey = scripts(3)[2]!;
      saveNative(f.root, state);
    };
    server.control.transform = (path, value) => { if (fault === "boolean-count" && path.endsWith("/commit")) (value as { handles_committed: unknown }).handles_committed = true; return value; };
    await assert.rejects(using(k, c => c.commitLocal("b1")), /differs|invalid|mismatched/);
    await assert.rejects(using(k, c => c.commitLocal("b1")), /already requested|ambiguous/);
    assert.equal(readNative(f.root).commits, 1); assert.equal(batches(k.database)[0]!.root, null);
  });
});

test("TypeScript preparation honors the B5 gate and refuses changed immutable duplicate bindings before effects", async (t) => {
  await withPreparation(t, async (k, f) => {
    const inspect = k.ports.preparation.registry.inspect.bind(k.ports.preparation.registry);
    k.ports.preparation.registry.inspect = oid => inspect("o1").pipe(Effect.map(order => ({ ...order, oid })));
    await assert.rejects(using(k, c => c.freeze("@space")), /unavailable|ineligible/);
    assert.equal(batches(k.database).length, 0); assert.equal(readNative(f.root).syncs, 0); assert.equal(readNative(f.root).commits, 0);
  });
  await withPreparation(t, async (k, f) => {
    k.journal.appendEvent("rebuild_guard", { version: 1, count: 3, last_bid: "b9", paused_at: f.node.tip, paused_bid: "b9" });
    await assert.rejects(using(k, c => c.freeze("@space")), /paused until/); assert.equal(batches(k.database).length, 0);
    f.node.tip++; await using(k, c => c.freeze("@space"));
    const inspect = k.ports.preparation.registry.inspect.bind(k.ports.preparation.registry);
    k.ports.preparation.registry.inspect = oid => inspect("o1").pipe(Effect.map(order => ({ ...order, oid })));
    await assert.rejects(using(k, c => c.stage("b1")), /digest|distinct handle/);
    assert.equal(readNative(f.root).syncs, 0); assert.equal(readNative(f.root).commits, 0);
  });
});
