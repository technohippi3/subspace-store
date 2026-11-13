import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { FileControllerJournal } from "../../src/controller/journal.ts";
import type { Batch } from "../../src/controller/records.ts";
import { fixture, use } from "./application-fixture.ts";
import { credential, faultProxy } from "./entry-http-fixture.ts";
import { delegate, local, put, using } from "./controller-port-fixture.ts";
import { batches, paidMembers, rebuildKernel, recordedSends } from "./controller-rebuild-fixture.ts";

test("O23: TypeScript release withholds native changes on either journal outage including loss after close", async (t) => {
  for (const fault of ["controller-before-close", "controller-before-rollback", "store-before-rollback", "store-before-park"]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      yield* Effect.promise(async () => {
        const proxy = await faultProxy(t, listener.url), k = rebuildKernel(f.root, proxy.url);
        if (fault === "controller-before-close") k.journal.afterAppend = b => { if (b.state === "releasing") k.journal.down = true; };
        if (fault === "controller-before-rollback") k.journal.afterAppend = b => { if (b.state === "rebuilding") k.journal.down = true; };
        if (fault === "store-before-rollback") k.journal.afterAppend = b => { if (b.state === "rebuilding") f.journal.down = true; };
        if (fault === "store-before-park") k.native.afterRollback = () => { f.journal.down = true; };
        await assert.rejects(using(k, c => c.releaseUnsent("b1", ["o2"])), /journal|acknowledged/);
        assert.equal(k.native.state().rollbacks, fault === "store-before-park" ? 1 : 0);
        assert.equal(k.native.state().parks, 0); assert.equal(batches(k.database).length, 1);
        if (fault === "controller-before-close") assert.equal(proxy.control.closes, 0);
        k.journal.down = false; f.journal.down = false; k.journal.afterAppend = undefined; k.native.afterRollback = undefined;
        assert.equal(await using(k, c => c.resumeRelease("b1")), "b2"); assert.equal(k.native.state().rollbacks, 1);
      });
    }));
  }
});

test("O24: TypeScript release preserves cancellation during unconfirmed close and retires all failed members once", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    const tokens = yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
    const proxy = yield* Effect.promise(() => faultProxy(t, listener.url)), k = rebuildKernel(f.root, proxy.url);
    proxy.control.beforeClose = () => { f.journal.down = true; };
    yield* Effect.promise(() => assert.rejects(using(k, c => c.releaseUnsent("b1", ["o2"])), /closure not acknowledged/));
    assert.equal(k.native.state().rollbacks, 0); assert.equal((yield* store.cancel(tokens[0]!)).cancellation, "unconfirmed");
    proxy.control.beforeClose = null; f.journal.down = false;
    yield* Effect.promise(async () => {
      assert.equal(await using(k, c => c.resumeRelease("b1")), null);
      assert.equal(await using(k, c => c.releaseUnsent("b1", ["o2"])), null);
      assert.deepEqual(JSON.parse(local(k.database).release_failed!), ["o1", "o2"]); assert.equal(batches(k.database).length, 1);
      await using(k, c => Effect.gen(function* () { assert.equal((yield* c.alerts()).filter(a => a.kind === "every_member_failed").length, 1); }));
    });
    assert.equal((yield* store.order(tokens[0]!)).status, "cancelled"); assert.equal(k.native.state().rollbacks, 1);
  }));
});

test("O25: TypeScript release process exits and lost replies finish one rollback and one sole successor", async (t) => {
  for (const mode of ["close-before", "close-after", "lose-rollback-reply", "lose-park-reply", "stop-after-releasing",
    "stop-after-rebuilding", "stop-after-rollback-intent", "stop-after-rollback", "stop-after-park", "stop-after-completion",
    "stop-after-child-ack", "stop-before-parent-ack", "stop-after-parent-ack"]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      yield* Effect.promise(async () => {
        const proxy = await faultProxy(t, listener.url), k = rebuildKernel(f.root, proxy.url);
        const child = async (mode: string) => {
          try { const result = await promisify(execFile)(process.execPath,
            ["test/production/controller-rebuild-process.ts", f.root, proxy.url, mode], { timeout: 30_000 });
            return JSON.parse(result.stdout) as { error: string | null; batches: Batch[] };
          } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === 9) return { error: "crashed", batches: [] };
            throw error;
          }
        };
        if (mode === "close-before") proxy.control.beforePath = "/operator/issuance-entries/close";
        if (mode === "close-after") proxy.control.afterPath = "/operator/issuance-entries/close";
        const first = await child(mode.startsWith("close-") ? "continue" : mode); assert(first.error, mode);
        if (mode.startsWith("stop-")) assert.equal(first.error, "crashed", mode);
        const next = await child("continue"); assert.equal(next.error, null, mode); assert.equal(next.batches[0]!.state, "rebuilt");
        assert.equal(k.native.state().rollbacks, 1, mode); assert.deepEqual(next.batches.filter(b => b.supersedes === "b1").map(b => b.bid), ["b2"]);
        assert.equal((await child("continue")).error, null); assert.equal(k.native.state().rollbacks, 1);
        assert.equal(recordedSends(f.root), 0); assert.equal(batches(k.database).length, 2);
      });
    }));
  }
});

test("O26: stale TypeScript releasing and rebuilding copies retain armed uncertainty and exact delegate", async (t) => {
  for (const state of ["releasing", "rebuilding"] as const) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
      const entry = { entry: "1".repeat(32), root: "a".repeat(64), oids: ["o1", "o2"] };
      yield* store.registry.entries.enter(entry); yield* store.registry.entries.arm({ ...entry, delegate });
      yield* Effect.promise(async () => {
        const row = { ...local(k.database), entry_key: entry.entry, state, release_failed: '["o2"]' };
        put(k.database, row); k.journal.append(row);
        await assert.rejects(using(k, c => c.resumeRelease("b1")), /armed|uncertain/);
        const saved = local(k.database); assert.equal(saved.state, "broadcast_uncertain"); assert.equal(saved.attempted, 1);
        assert.equal(saved.intent, 1); assert.equal(saved.delegate_in, delegate);
        await using(k, c => Effect.gen(function* () { assert.equal((yield* c.alerts()).filter(a => a.kind === "broadcast_uncertain").length, 1); }));
        await assert.rejects(using(k, c => c.releaseUnsent("b1", ["o2"])), /possible send/);
        assert.equal(k.native.state().rollbacks, 0); assert.equal(k.native.state().parks, 0); assert.equal(batches(k.database).length, 1);
      });
      assert.equal((yield* store.inspectionOrder("o1")).status, "issuing");
    }));
  }
});

test("A27: TypeScript release refuses unavailable history, conflicting precommit state and foreign native roots or scripts", async (t) => {
  for (const fault of ["journal", "script", "foreign-root", "mixed-root", "older-precommit", "native-shape", "park-shape"]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      yield* Effect.promise(async () => {
        const proxy = await faultProxy(t, listener.url), k = rebuildKernel(f.root, proxy.url), native = k.native.state();
        if (fault === "journal") k.journal.down = true;
        if (fault === "script") native.handles.n0!.script_pubkey = "5120" + "f".repeat(64);
        if (fault === "foreign-root") native.handles.n0!.commitment_root = "b".repeat(64);
        if (fault === "mixed-root") native.handles.n0!.commitment_root = null;
        if (fault === "native-shape") (native.handles.n0 as unknown as { parked: string }).parked = "false";
        k.native.save(native);
        if (fault === "park-shape") k.native.afterPark = () => { const value = k.native.state(); value.handles.n0!.parked = true; k.native.save(value); };
        if (fault === "older-precommit") put(k.database, { ...local(k.database), root: null, state: "frozen" });
        await assert.rejects(using(k, c => c.releaseUnsent("b1", ["o2"])), /journal|binding|root|recipient|membership/);
        assert.equal(k.native.state().rollbacks, fault === "park-shape" ? 1 : 0); assert.equal(batches(k.database).length, 1);
        if (["journal", "older-precommit"].includes(fault)) assert.equal(proxy.control.closes, 0);
      });
    }));
  }
});

test("TypeScript preclosed issue and resume retain healthy converted members in the successor", async (t) => {
  for (const phase of ["checkpointed", "issuing"] as const) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
      const entry = { entry: "1".repeat(32), root: "a".repeat(64), oids: ["o1", "o2"] };
      yield* store.registry.entries.enter(entry); yield* store.registry.entries.close(entry);
      yield* Effect.promise(async () => {
        const row = { ...local(k.database), entry_key: entry.entry, state: phase,
          ...(phase === "issuing" ? { intent: 1, delegate_in: delegate, fee_rate: 1 } : {}) };
        put(k.database, row); k.journal.append(row);
        const child = await using(k, c => phase === "checkpointed" ? c.issue("b1") : c.resume("b1"));
        assert.equal(child.bid, "b2"); assert.deepEqual(child.members, ["o1", "o2"]); assert.equal(child.state, "frozen");
        assert.equal(k.calls.broadcasts, 0);
      });
    }));
  }
});

test("TypeScript release accepts legacy Python batch envelopes missing additive fields and retains historical send fences", async (t) => {
  for (const attempted of [0, 1]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
      yield* Effect.promise(async () => {
        const legacy = { ...local(k.database), attempted } as Partial<Batch>;
        delete legacy.ancestors; delete legacy.entry_key; delete legacy.release_failed;
        writeFileSync(k.journal.path, JSON.stringify({ seq: 1, kind: "batch", batch: legacy }) + "\n");
        const config = { database: k.database, makeJournal: () => new FileControllerJournal(k.directory) };
        if (attempted) await assert.rejects(using({ ...k, config }, c => c.releaseUnsent("b1", ["o2"])), /possible send|evidence/);
        else assert.equal(await using({ ...k, config }, c => c.releaseUnsent("b1", ["o2"])), "b2");
        assert.equal(k.native.state().rollbacks, attempted ? 0 : 1);
      });
    }));
  }
});

test("TypeScript release checks supplied closed receipts and records an exact armed response", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
    yield* Effect.promise(async () => {
      for (const receipt of ["wrong-root", "armed"] as const) {
        const ports = { ...k.ports, registry: { ...k.ports.registry, close: (b: Batch) => Effect.succeed({ found: true as const,
          entry: b.entry_key!, root: receipt === "wrong-root" ? "b".repeat(64) : b.root!, oids: b.members,
          phase: receipt === "armed" ? "armed" as const : "closed" as const, delegate: receipt === "armed" ? delegate : null,
          acknowledged: true, batchable: false }) } };
        await assert.rejects(using({ ...k, ports }, c => c.releaseUnsent("b1", ["o2"])), /mismatched|armed/);
        assert.equal(k.native.state().rollbacks, 0);
      }
      assert.equal(local(k.database).state, "broadcast_uncertain"); assert.equal(local(k.database).delegate_in, delegate);
    });
  }));
});
