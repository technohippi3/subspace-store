import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { FileControllerJournal } from "../../src/controller/journal.ts";
import { BatchDatabase } from "../../src/controller/database.ts";
import { ControllerError } from "../../src/controller/errors.ts";
import type { Batch } from "../../src/controller/records.ts";
import type { OrderBinding } from "../../src/controller/ports.ts";
import { fixture, use } from "./application-fixture.ts";
import { credential } from "./entry-http-fixture.ts";
import { delegate, local, put, txid, using } from "./controller-port-fixture.ts";
import { batches, paidMembers, rebuildKernel } from "./controller-rebuild-fixture.ts";

test("A28: TypeScript rollback readback survives lost response and rejects a corrupt sole-successor digest", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
    yield* Effect.promise(async () => {
      k.native.afterRollback = () => { throw new ControllerError({ code: "unavailable", message: "lost fake rollback reply" }); };
      await assert.rejects(using(k, c => c.releaseUnsent("b1", ["o2"])), /lost fake rollback reply/);
      assert.equal(local(k.database).state, "rebuilding"); k.native.afterRollback = undefined;
      assert.equal(await using(k, c => c.resumeRelease("b1")), "b2"); assert.equal(k.native.state().rollbacks, 1);
      assert.equal(await using(k, c => c.resumeRelease("b1")), "b2"); assert.equal(k.native.state().rollbacks, 1);
      const child = batches(k.database).find(b => b.bid === "b2")!; put(k.database, { ...child, digest: "corrupt" }); k.journal.append({ ...child, digest: "corrupt" });
      await assert.rejects(using(k, c => c.resumeRelease("b1")), /successor differs/); assert.equal(batches(k.database).length, 2);
    });
  }));
});

test("A29: TypeScript precommit release leaves the prior native root intact and refuses an unresolved local commit", async (t) => {
  for (const committed of [false, true]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
      yield* Effect.promise(async () => {
        const row = { ...local(k.database), state: "staged" as const, root: null, prior_root: "e".repeat(64) };
        put(k.database, row); writeFileSync(k.journal.path, JSON.stringify({ seq: 1, kind: "batch", batch: row }) + "\n");
        const journal = new FileControllerJournal(k.directory);
        if (committed) journal.appendEvent("commit_local_intent", { bid: "b1", space: "@space" });
        const subject = { ...k, config: { database: k.database, makeJournal: () => journal } };
        if (committed) await assert.rejects(using(subject, c => c.releaseUnsent("b1", ["o2"], true)), /no confirmed root/);
        else {
          assert.equal(await using(subject, c => c.releaseUnsent("b1", ["o2"], true)), "b2");
          assert.equal(batches(k.database)[1]!.prior_root, row.prior_root);
        }
        assert.equal(k.native.state().rollbacks, 0); assert.equal(k.native.state().parks, 0);
        assert.equal(k.native.state().handles.n0!.commitment_root, "a".repeat(64));
        assert.equal(journal.entries().filter(e => e.kind === "entry_rollback_intent").length, 0);
      });
    }));
  }
});

test("A30: TypeScript exclusions grow during release and original retries cannot retire or create twice", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
    k.native.afterRollback = () => { f.node.outputs[0]!.confirmations = 2; };
    yield* Effect.promise(async () => {
      assert.equal(await using(k, c => c.releaseUnsent("b1", ["o2"])), null);
      assert.equal(await using(k, c => c.releaseUnsent("b1", ["o2"])), null);
      assert.deepEqual(JSON.parse(local(k.database).release_failed!), ["o1", "o2"]); assert.equal(batches(k.database).length, 1);
      await using(k, c => Effect.gen(function* () { assert.equal((yield* c.alerts()).filter(a => a.kind === "every_member_failed").length, 1); }));
      assert.equal(k.native.state().rollbacks, 1);
    });
  }));
});

test("A31: TypeScript restart unions both exclusion copies without downgrading acknowledged closed progress", async (t) => {
  for (const [localState, journalState] of [["releasing", "releasing"], ["rebuilding", "releasing"], ["releasing", "rebuilding"],
    ["rebuilding", "rebuilding"]] as const) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
      const row = { ...local(k.database), entry_key: "1".repeat(32), state: journalState, release_failed: '["o2"]' };
      yield* store.registry.entries.close({ entry: row.entry_key, root: row.root!, oids: row.members });
      yield* Effect.promise(async () => {
        k.journal.append(row); put(k.database, { ...row, state: localState, release_failed: '["o1"]' });
        await using(k, c => Effect.gen(function* () {
          const saved = yield* c.batch("b1"); assert.deepEqual(JSON.parse(saved.release_failed!), ["o1", "o2"]);
          assert.equal(saved.state, [localState, journalState].includes("rebuilding") ? "rebuilding" : "releasing");
          assert.equal(yield* c.resumeRelease("b1"), null);
        }));
        assert.equal(k.native.state().rollbacks, 1); assert.equal(batches(k.database).length, 1);
      });
    }));
  }
});

test("TypeScript release refuses later journal sends and local contradictory send evidence before any close", async (t) => {
  for (const evidence of ["journal-attempted", "journal-sent", "local-txid", "local-raw", "local-attempted"] as const) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
      yield* Effect.promise(async () => {
        const row = { ...local(k.database), state: "rebuilding" as const, entry_key: "1".repeat(32), release_failed: '["o2"]' };
        put(k.database, { ...row, ...(evidence === "local-txid" ? { txid } : evidence === "local-raw" ? { raw: "00" } :
          evidence === "local-attempted" ? { attempted: 1 } : {}) });
        k.journal.append({ ...row, ...(evidence === "journal-attempted" ? { attempted: 1 } :
          evidence === "journal-sent" ? { attempted: 1, state: "broadcast" as const, txid } : {}) });
        await assert.rejects(using(k, c => c.resumeRelease("b1")), /possible.send|possible send|evidence/);
        assert.equal(k.native.state().rollbacks, 0); assert.equal(k.native.state().parks, 0); assert.equal(batches(k.database).length, 1);
      });
    }));
  }
});

test("TypeScript rebuild successor digest matches Python json.dumps on actual HTTP member bindings", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f, 4); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url, 4);
    const row = { ...local(k.database), members: ["o1", "o2", "o3", "o4"] }; put(k.database, row); k.journal.append(row);
    const orders = yield* Effect.forEach(row.members, id => store.inspectionOrder(id));
    yield* Effect.promise(async () => {
      const expected = await promisify(execFile)("python3", ["-c", "import hashlib,json,sys;rows=json.loads(sys.argv[1]);print(hashlib.sha256(json.dumps(sorted((o['name'],o['recipient_spk'],o['oid']) for o in rows if o['oid']!='o2')).encode()).hexdigest())", JSON.stringify([...orders].reverse())], { cwd: resolve("..") });
      assert.equal(await using(k, c => c.releaseUnsent("b1", ["o2"])), "b2");
      assert.equal(batches(k.database)[1]!.digest, expected.stdout.trim());
      assert.deepEqual(batches(k.database)[1]!.members, ["o1", "o3", "o4"]);
    });
  }));
});

test("TypeScript parent retirement and child or all-failed alert roll back together on SQLite failure", async (t) => {
  for (const failed of [["o2"], ["o1", "o2"]]) {
    const f = fixture(t), k = rebuildKernel(f.root, "http://127.0.0.1:1"), owner = new BatchDatabase(k.database);
    const db = new DatabaseSync(k.database);
    db.exec("create trigger fail_retirement before update on batches when new.state='rebuilt' begin select raise(abort, 'retirement write failure'); end");
    assert.throws(() => owner.completeRebuild("b1", failed, "mock-digest", false), /retirement write failure/);
    assert.equal(owner.get("b1").state, "checkpointed"); assert.equal(owner.batches().length, 1); assert.equal(owner.alerts().length, 0);
    db.exec("drop trigger fail_retirement"); db.close(); owner.close();
  }
});

test("TypeScript parent completion cannot overwrite newer successor entry identity or unattempted intent", async (t) => {
  for (const state of ["checkpointed", "issuing"] as const) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
      yield* Effect.promise(async () => {
        await using(k, c => c.releaseUnsent("b1", ["o2"]));
        const child = batches(k.database)[1]!, newer = { ...child, state, entry_key: "2".repeat(32),
          ...(state === "issuing" ? { intent: 1, delegate_in: "d".repeat(64) + ":0", fee_rate: 1 } : {}) };
        k.journal.append(newer); const before = readFileSync(k.journal.path, "utf8");
        await assert.rejects(using(k, c => c.resumeRelease("b1")), /successor journal differs/);
        assert.equal(readFileSync(k.journal.path, "utf8"), before); assert.equal(k.calls.broadcasts, 0);
        assert.equal(batches(k.database)[1]!.entry_key, null); assert.equal(k.native.state().rollbacks, 1);
      });
    }));
  }
});

test("TypeScript stale database and journal cannot release an entry after its one recorded send", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
    yield* Effect.promise(async () => {
      const oldDatabase = join(f.root, "older-controller.db"), oldJournal = join(f.root, "older-controller.jsonl");
      const row = { ...local(k.database), entry_key: "1".repeat(32), state: "issuing" as const, intent: 1, fee_rate: 1, delegate_in: delegate };
      put(k.database, row); k.journal.append(row);
      // Stop after the stable identity+unattempted intent, before the first arm.
      await Effect.runPromise(k.ports.registry.enter(row));
      copyFileSync(k.database, oldDatabase); copyFileSync(k.journal.path, oldJournal);
      await using(k, c => c.resume("b1")); assert.equal(k.calls.broadcasts, 1);
      copyFileSync(oldDatabase, k.database); copyFileSync(oldJournal, k.journal.path);
      const config = { database: k.database, makeJournal: () => new FileControllerJournal(k.directory) };
      await assert.rejects(using({ ...k, config }, c => c.releaseUnsent("b1", ["o2"])), /armed/);
      assert.equal(k.calls.broadcasts, 1); assert.equal(k.native.state().rollbacks, 0);
    });
  }));
});

test("TypeScript forgotten pre-entry snapshots cannot retire or roll back members owned by a foreign armed entry", async (t) => {
  for (const rootless of [false, true]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
      const prior = rootless ? { ...local(k.database), root: null, state: "frozen" as const } : local(k.database);
      if (rootless) { put(k.database, prior); writeFileSync(k.journal.path, JSON.stringify({ seq: 1, kind: "batch", batch: prior }) + "\n"); }
      const oldDatabase = join(f.root, "forgotten-controller.db"), oldJournal = join(f.root, "forgotten-controller.jsonl");
      copyFileSync(k.database, oldDatabase); copyFileSync(k.journal.path, oldJournal);
      let foreign: { entry: string; root: string; oids: string[] };
      if (rootless) {
        foreign = { entry: "3".repeat(32), root: "a".repeat(64), oids: ["o1", "o2"] };
        yield* store.registry.entries.enter(foreign); yield* store.registry.entries.arm({ ...foreign, delegate });
      } else {
        yield* Effect.promise(() => using(k, c => c.issue("b1")));
        foreign = { entry: local(k.database).entry_key!, root: prior.root!, oids: prior.members };
      }
      const beforeSends = k.calls.broadcasts;
      copyFileSync(oldDatabase, k.database); copyFileSync(oldJournal, k.journal.path);
      yield* Effect.promise(async () => {
        const config = { database: k.database, makeJournal: () => new FileControllerJournal(k.directory) };
        await assert.rejects(using({ ...k, config }, c => c.releaseUnsent("b1", ["o2"])), /foreign issuance/);
        assert.equal(k.native.state().rollbacks, 0); assert.equal(k.native.state().parks, 0); assert.equal(k.calls.broadcasts, beforeSends);
        assert.equal(batches(k.database).length, 1); assert.notEqual(local(k.database).state, "rebuilt");
        await using({ ...k, config }, c => Effect.gen(function* () { assert.equal((yield* c.alerts()).length, 0); }));
      });
      const retained = yield* store.registry.entries.find(foreign); assert.equal(retained.found, true);
      if (retained.found) assert.equal(retained.phase, "armed");
      assert.equal((yield* store.inspectionOrder("o1")).status, "issuing"); assert.equal(k.native.state().handles.n0!.commitment_root, "a".repeat(64));
    }));
  }
});

test("TypeScript first retirement validates every member status but completed-parent retry permits its issuing child", async (t) => {
  for (const status of [undefined, "unknown", "issuing", "ready", "fulfilled"]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
      const row = { ...local(k.database), root: null, state: "frozen" as const }; put(k.database, row);
      writeFileSync(k.journal.path, JSON.stringify({ seq: 1, kind: "batch", batch: row }) + "\n");
      const ports = { ...k.ports, registry: { ...k.ports.registry, order: (b: Batch, id: string) => k.ports.registry.order(b, id)
        .pipe(Effect.map(value => ({ ...value, ...(id === "o2" ? { status } : {}) }) as OrderBinding)) } };
      yield* Effect.promise(async () => {
        await assert.rejects(using({ ...k, ports, config: { database: k.database, makeJournal: () => new FileControllerJournal(k.directory) } },
          c => c.releaseUnsent("b1", ["o2"])), /binding|foreign issuance/);
        assert.equal(local(k.database).state, "frozen"); assert.equal(batches(k.database).length, 1);
      });
    }));
  }
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
    yield* Effect.promise(() => using(k, c => c.releaseUnsent("b1", ["o2"])));
    yield* store.registry.entries.enter({ entry: "4".repeat(32), root: "b".repeat(64), oids: ["o1"] });
    yield* Effect.promise(async () => {
      assert.equal(await using(k, c => c.resumeRelease("b1")), "b2"); assert.equal(k.native.state().rollbacks, 1);
    });
    assert.equal((yield* store.inspectionOrder("o1")).status, "issuing");
  }));
});

test("TypeScript whole-prefix release guard retains attempted evidence hidden behind a later stale clean row", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
    yield* Effect.promise(async () => {
      const clean = { ...local(k.database), state: "releasing" as const, entry_key: "1".repeat(32), release_failed: '["o2"]' };
      k.journal.append({ ...clean, state: "issuing", attempted: 1, intent: 1, delegate_in: delegate, fee_rate: 1 });
      k.journal.append(clean); put(k.database, clean); const before = readFileSync(k.journal.path, "utf8");
      await assert.rejects(using(k, c => c.resumeRelease("b1")), /possible send/);
      assert.equal(readFileSync(k.journal.path, "utf8"), before); assert.equal(k.native.state().rollbacks, 0); assert.equal(k.native.state().parks, 0);
    });
  }));
});
