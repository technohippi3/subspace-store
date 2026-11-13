import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { HttpRegistry } from "../../src/controller/registry-client.ts";
import { preparationHistory } from "../../src/controller/preparation-history.ts";
import { withPreparation } from "./controller-preparation-fixture.ts";
import { credential, faultProxy } from "./entry-http-fixture.ts";
import { checkpoint, delegate, put, using } from "./controller-port-fixture.ts";
import { batches, scripts } from "./controller-rebuild-fixture.ts";
import { payment } from "./application-fixture.ts";
import { readNative } from "./controller-preparation-native.ts";

async function delayedPending(t: TestContext, target: string, root: string, clear: boolean) {
  let queued = false;
  const file = join(root, "delayed-pending.json"), server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part)); const raw = Buffer.concat(chunks).toString();
    if (!queued && request.url === "/operator/pending" && ((JSON.parse(raw) as { oids: string[] }).oids.length === 0) === clear) {
      queued = true; writeFileSync(file, raw); response.destroy(); return;
    }
    try { const upstream = await fetch(target + request.url, { method: request.method!, headers: { Authorization: `Bearer ${credential}` },
      ...(request.method === "POST" ? { body: raw } : {}) }); response.writeHead(upstream.status); response.end(await upstream.text()); }
    catch { response.destroy(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const address = server.address(); assert(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, apply: async () => {
    const response = await fetch(target + "/operator/pending", { method: "POST", headers: { Authorization: `Bearer ${credential}` }, body: readFileSync(file, "utf8") }); assert.equal(response.status, 200);
  } };
}

test("O8: TypeScript pending false acknowledgments are completed requests but withhold sync or staged transition", async (t) => {
  for (const clear of [false, true]) await withPreparation(t, async (k, f, native) => {
    await using(k, c => c.freeze("@space"));
    if (clear) native.control.after = path => { if (path === "/registry/sync") f.journal.down = true; }; else f.journal.down = true;
    await assert.rejects(using(k, c => c.stage("b1")), /not acknowledged/);
    const held = preparationHistory(k.journal.entries()); assert.equal(held.owner?.bid, "b1"); assert.equal(held.unresolved, null);
    const response = k.journal.entries().filter(e => e.kind === "preparation_effect").at(-1)!;
    assert.equal(response.operation, clear ? "pending_clear" : "pending_set"); assert.equal(response.acknowledged, false);
    assert.equal(readNative(f.root).syncs, clear ? 1 : 0); assert.equal(batches(k.database)[0]!.state, "frozen");
    f.journal.down = false; native.control.after = undefined;
    assert.equal((await using(k, c => c.stage("b1"))).state, "staged"); assert.equal(readNative(f.root).syncs, 1);
  });
});

test("TypeScript pending set and clear missing replies before or after forwarding never grant another request", async (t) => {
  for (const clear of [false, true]) for (const boundary of ["before", "after"] as const) await withPreparation(t, async (k, f, native, _store, operator) => {
    const proxy = await faultProxy(t, operator), registry = new HttpRegistry(proxy.url, Effect.succeed(credential));
    const subject = { ...k, ports: { ...k.ports, preparation: { ...k.ports.preparation, registry } } };
    await using(subject, c => c.freeze("@space"));
    const armLoss = () => { proxy.control[boundary === "before" ? "beforePath" : "afterPath"] = "/operator/pending"; };
    if (clear) native.control.after = path => { if (path === "/registry/sync") armLoss(); }; else armLoss();
    await assert.rejects(using(subject, c => c.stage("b1")), /response unavailable/);
    const history = preparationHistory(k.journal.entries()); assert.equal(history.unresolved?.operation, clear ? "pending_clear" : "pending_set");
    await assert.rejects(using(subject, c => c.stage("b1")), /reconciliation/);
    await assert.rejects(using(subject, c => c.commitLocal("b1")), /reconciliation/);
    await assert.rejects(using(subject, c => c.releaseUnsent("b1", ["o2"])), /reconciliation/);
    assert.equal(readNative(f.root).syncs, clear ? 1 : 0); assert.equal(readNative(f.root).commits, 0);
  });
});

test("TypeScript delayed old pending set or clear cannot escape into another batch after an apparent readback", async (t) => {
  for (const clear of [false, true]) await withPreparation(t, async (k, f, native, _store, operator) => {
    const proxy = await delayedPending(t, operator, f.root, clear), registry = new HttpRegistry(proxy.url, Effect.succeed(credential));
    const subject = { ...k, ports: { ...k.ports, preparation: { ...k.ports.preparation, registry } } };
    await using(subject, c => c.freeze("@space")); await assert.rejects(using(subject, c => c.stage("b1")), /response unavailable/);
    await assert.rejects(using(subject, c => c.freeze("@other")), /reconciliation/);
    await assert.rejects(using(subject, c => c.releaseUnsent("b1", ["o2"])), /reconciliation/);
    await proxy.apply();
    await assert.rejects(using(subject, c => c.stage("b1")), /reconciliation/);
    assert.equal(preparationHistory(k.journal.entries()).unresolved?.operation, clear ? "pending_clear" : "pending_set");
    assert.equal(batches(k.database).length, 1); assert.equal(readNative(f.root).commits, 0);
    native.control.after = undefined;
  });
});

test("TypeScript stage owner fences an otherwise eligible existing issuing batch before arm or broadcast", async (t) => {
  await withPreparation(t, async (k, f, native, store) => {
    await using(k, c => c.freeze("@space"));
    await Effect.runPromise(store.listName("extra@other", 1000));
    const request = await Effect.runPromise(store.request({ handle: "extra@other", script_pubkey: scripts(3)[2]! }));
    await Effect.runPromise(store.quote(request.token)); f.node.outputs.push(payment(3)); await Effect.runPromise(store.observe());
    const other = checkpoint({ bid: "b2", space: "@other", members: ["o3"], state: "issuing", root: "c".repeat(64), entry_key: "2".repeat(32), intent: 1, delegate_in: delegate, fee_rate: 1 });
    await Effect.runPromise(k.ports.registry.enter(other)); put(k.database, other); k.journal.append(other);
    native.control.loseBefore = "/registry/sync"; await assert.rejects(using(k, c => c.stage("b1")), /unavailable/);
    const before = batches(k.database).find(b => b.bid === "b2")!; assert.equal(before.attempted, 0);
    await assert.rejects(using(k, c => c.send("b2")), /preparation|reconciliation/);
    assert.equal(batches(k.database).find(b => b.bid === "b2")!.attempted, 0); assert.equal(k.calls.broadcasts, 0);
    const entry = await Effect.runPromise(k.ports.registry.lookup(other)); assert(entry.found); assert.equal(entry.phase, "open");
  });
});
