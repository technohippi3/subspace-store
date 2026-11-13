import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { FileControllerJournal, RemoteControllerJournal } from "../../src/controller/journal.ts";
import { RecoveryCommand } from "../../src/storage/ssh-journal.ts";
import { RebuildPolicy } from "../../src/controller/rebuild-policy.ts";
import { fixture, use } from "./application-fixture.ts";
import { credential } from "./entry-http-fixture.ts";
import { checkpoint, local, put, using } from "./controller-port-fixture.ts";
import { batches, paidMembers, rebuildKernel, recordedSends } from "./controller-rebuild-fixture.ts";

test("B5: TypeScript failures persist across guard crashes, third failure pauses one block and historical parent stays childless", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f, 4); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url, 4);
    const initial = { ...local(k.database), members: ["o1", "o2", "o3", "o4"] }; put(k.database, initial); k.journal.append(initial);
    yield* Effect.promise(async () => {
      const child = async (mode: string, bid: string, failed: string) => promisify(execFile)(process.execPath,
        ["test/production/controller-rebuild-process.ts", f.root, listener.url, mode, bid, failed, "failure"], { timeout: 30_000 });
      let bid = "b1";
      for (let n = 1; n <= 3; n++) {
        if (n === 1) await assert.rejects(child("stop-after-guard", bid, `o${n}`), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === 9);
        const result = JSON.parse((await child("continue", bid, `o${n}`)).stdout) as { error: string | null };
        const guards = k.journal.entries().filter(event => event.kind === "rebuild_guard"); assert.equal(guards.at(-1)!.count, n);
        if (n === 3) { assert.match(result.error!, /three rebuilds/); break; }
        assert.equal(result.error, null); bid = `b${n + 1}`;
        const next = batches(k.database).find(b => b.bid === bid)!, root = String(n + 1).repeat(64);
        const prepared = { ...next, state: "checkpointed" as const, root }; put(k.database, prepared); k.journal.append(prepared);
        const native = k.native.state(); for (const id of next.members) native.handles[`n${Number(id.slice(1)) - 1}`]!.commitment_root = root; k.native.save(native);
      }
      assert.equal(k.journal.entries().filter(event => event.kind === "rebuild_guard" && event.last_bid === "b1").length, 1);
      assert.equal(recordedSends(f.root), 0); assert(!batches(k.database).some(b => b.supersedes === "b3"));
      const next = checkpoint({ bid: "b4", members: ["o4"], root: "4".repeat(64) }); put(k.database, next); k.journal.append(next);
      const native = k.native.state(); native.handles.n3!.commitment_root = next.root; k.native.save(native);
      await assert.rejects(using(k, c => c.issue("b4")), /next block/);
      await assert.rejects(using(k, c => c.send("b4")), /next block/); assert.equal(k.calls.broadcasts, 0);
      native.height++; k.native.save(native); assert.equal((await using(k, c => c.issue("b4"))).state, "broadcast");
      assert.equal(k.journal.entries().filter(event => event.kind === "rebuild_guard").at(-1)!.count, 0);
      await assert.rejects(using(k, c => c.releaseUnsent("b3", ["o3"], true)), /three rebuilds/);
      assert(!batches(k.database).some(b => b.supersedes === "b3"));
      await using(k, c => Effect.gen(function* () { assert.equal((yield* c.alerts()).filter(a => a.kind === "rebuilds").length, 1); }));
    });
  }));
});

test("TypeScript B5 interleaved parents and resets do not recount a guard acknowledged before process death", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
    yield* Effect.promise(async () => {
      await assert.rejects(promisify(execFile)(process.execPath,
        ["test/production/controller-rebuild-process.ts", f.root, listener.url, "stop-after-guard", "b1", "o2", "failure"]),
        (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === 9);
      const policy = new RebuildPolicy(k.journal, () => Effect.succeed(10));
      await Effect.runPromise(policy.note("b9")); assert.equal(k.journal.entries().at(-1)!.count, 2);
      const before = readFileSync(k.journal.path, "utf8"); await Effect.runPromise(policy.note("b1")); assert.equal(readFileSync(k.journal.path, "utf8"), before);
      await Effect.runPromise(policy.reset());
      const restarted = new RebuildPolicy(new FileControllerJournal(k.directory), () => Effect.succeed(10));
      await Effect.runPromise(restarted.note("b1")); assert.equal(k.journal.entries().at(-1)!.count, 0);
      assert.equal(await using(k, c => c.releaseUnsent("b1", ["o2"], true)), "b2");
      assert.equal(k.journal.entries().filter(e => e.kind === "rebuild_guard" && e.last_bid === "b1").length, 1);
    });
  }));
});

test("TypeScript fresh issue resets B5 before send while resumed intent preserves intervening failures and pause", async (t) => {
  for (const count of [1, 3]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
      yield* Effect.promise(async () => {
        k.journal.afterAppend = b => { if (b.state === "issuing") k.journal.down = true; };
        await assert.rejects(using(k, c => c.issue("b1")), /journal/); k.journal.down = false; k.journal.afterAppend = undefined;
        k.journal.appendEvent("rebuild_guard", { version: 1, count, last_bid: "b9", paused_at: count === 3 ? 10 : null, paused_bid: count === 3 ? "b9" : null });
        if (count === 3) await assert.rejects(using(k, c => c.resume("b1")), /next block/);
        else assert.equal((await using(k, c => c.resume("b1"))).state, "broadcast");
        assert.equal(k.journal.entries().filter(e => e.kind === "rebuild_guard").at(-1)!.count, count);
        assert.equal(k.calls.broadcasts, count === 3 ? 0 : 1);
      });
    }));
  }
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
    yield* Effect.promise(async () => {
      k.journal.appendEvent("rebuild_guard", { version: 1, count: 2, last_bid: "b9", paused_at: null, paused_bid: null });
      k.calls.broadcastError = true; assert.equal((await using(k, c => c.issue("b1"))).state, "broadcast_uncertain");
      assert.equal(k.journal.entries().filter(e => e.kind === "rebuild_guard").at(-1)!.count, 0);
    });
  }));
});

test("TypeScript remote pending guard resolves before deriving a different failure or fresh-binding reset", async (t) => {
  for (const loss of ["before", "after"] as const) for (const operation of ["next-failure", "reset"] as const) {
    const f = fixture(t), file = join(f.root, "remote.json"); writeFileSync(file, JSON.stringify({ loss, objects: [] }));
    const helper = resolve("test/production/controller-rebuild-remote-helper.ts"), command = new RecoveryCommand(process.execPath, helper, file);
    const journal = new RemoteControllerJournal(command), policy = new RebuildPolicy(journal, () => Effect.succeed(10));
    await assert.rejects(Effect.runPromise(policy.note("b1")), /unavailable/);
    if (operation === "next-failure") await Effect.runPromise(policy.note("b2")); else await Effect.runPromise(policy.reset());
    const events = journal.entries(); assert.deepEqual(events.map(event => event.count), [1, operation === "next-failure" ? 2 : 0]);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { objects: { data: string }[] };
    assert.equal(saved.objects.length, 2); const first = saved.objects[0]!.data;
    const restarted = new RemoteControllerJournal(command); assert.equal(restarted.entries()[0]!.last_bid, "b1");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).objects[0].data, first);
    // A new Node process reconstructs policy using only the retained remote prefix.
    const script = `import {Effect} from 'effect';import {RemoteControllerJournal} from './src/controller/journal.ts';import {RecoveryCommand} from './src/storage/ssh-journal.ts';import {RebuildPolicy} from './src/controller/rebuild-policy.ts';const journal=new RemoteControllerJournal(new RecoveryCommand(process.execPath,process.argv[1],process.argv[2]));const policy=new RebuildPolicy(journal,()=>Effect.succeed(10));await Effect.runPromise(policy.note('b1'));console.log(JSON.stringify(journal.entries()));`;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, helper, file]);
    assert.deepEqual((JSON.parse(result.stdout) as { count: number }[]).map(e => e.count), [1, operation === "next-failure" ? 2 : 0]);
  }
});

test("TypeScript startup refuses malformed B5 history and retains prior inflated counts without rewriting", async (t) => {
  for (const change of [{ version: 99 }, { count: -1 }, { count: 3, paused_at: null }, { last_bid: "wrong" }, { extra: true }]) {
    const f = fixture(t), k = rebuildKernel(f.root, "http://127.0.0.1:1");
    const entry = { seq: 2, kind: "rebuild_guard", version: 1, count: 1, last_bid: "b1", paused_at: null, paused_bid: null, ...change };
    writeFileSync(k.journal.path, readFileSync(k.journal.path, "utf8") + JSON.stringify(entry) + "\n");
    await assert.rejects(using(k, c => c.batch("b1")), /invalid rebuild guard/); assert.equal(local(k.database).state, "checkpointed");
  }
  const f = fixture(t), k = rebuildKernel(f.root, "http://127.0.0.1:1");
  k.journal.appendEvent("rebuild_guard", { version: 1, count: 3, last_bid: "b1", paused_at: 10, paused_bid: "b1" });
  const before = readFileSync(k.journal.path, "utf8"), policy = new RebuildPolicy(k.journal, () => Effect.succeed(10));
  await Effect.runPromise(policy.note("b1")); assert.equal(readFileSync(k.journal.path, "utf8"), before); assert.equal(policy.paused("b1"), true);
});

test("TypeScript process exit after fresh-binding reset retains one entry and one later send", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential)), k = rebuildKernel(f.root, listener.url);
    k.journal.appendEvent("rebuild_guard", { version: 1, count: 2, last_bid: "b9", paused_at: null, paused_bid: null });
    yield* Effect.promise(async () => {
      const child = (mode: string) => promisify(execFile)(process.execPath,
        ["test/production/controller-rebuild-process.ts", f.root, listener.url, mode], { timeout: 30_000 });
      await assert.rejects(child("stop-after-reset"), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === 9);
      const key = local(k.database).entry_key; assert(key); assert.equal(local(k.database).state, "checkpointed");
      assert.equal(k.journal.entries().filter(e => e.kind === "rebuild_guard").at(-1)!.count, 0); assert.equal(recordedSends(f.root), 0);
      assert.equal(JSON.parse((await child("issue")).stdout).error, null); assert.equal(local(k.database).entry_key, key);
      assert.equal(recordedSends(f.root), 1); await child("issue"); assert.equal(recordedSends(f.root), 1);
    });
  }));
});
