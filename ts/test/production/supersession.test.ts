import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { payment, use } from "./application-fixture.ts";
import { supersessionFixture } from "./supersession-fixture.ts";
import { armed } from "./commitment-fixture.ts";
import { serveOperator } from "../../src/application/operator-http.ts";
import { credential, faultProxy } from "./entry-http-fixture.ts";
import { DurableStore } from "../../src/storage/store.ts";

test("O77: reversal blocks a different checkout and entry for the same handle after cancellation", async (t) => {
  for (const armedReplacement of [false,true]) {
    const f = supersessionFixture(t);
    await use(f, store => Effect.gen(function* () {
      const p = yield* f.prepare(store); yield* store.registry.supersessions.accept(p.input); yield* store.cancel(p.tokens[0]!);
      const later = yield* store.request({ handle: "n0@space", script_pubkey: "5120" + "3".padStart(64,"0") });
      yield* store.quote(later.token); f.node.outputs.push(payment(3));
      assert.equal((yield* store.order(later.token)).status,"converted");
      const next = { entry: "8".repeat(32), root: "9".repeat(64), oids: ["o3"], delegate: "2".repeat(64) + ":0" };
      if (armedReplacement) { yield* store.registry.entries.enter({ entry: next.entry, root: next.root, oids: next.oids }); yield* store.registry.entries.arm(next); }
      f.control.valid = false; yield* store.observe();
      assert.equal((yield* store.order(p.tokens[0]!)).status,"cancelled");
      const eligibility = yield* store.registry.entry("o3"); assert.equal(eligibility.batch_entry,false); assert.equal(eligibility.issuing_recheck,false);
      if (armedReplacement) {
        const status = yield* store.registry.supersessions.current(next); assert.equal(status.conflicted,true);
        assert.equal((yield* Effect.result(store.registry.commitments.observe({ ...next, expectedRevision: 0,
          observation: { ...f.facts(null,null,300), txid: "b".repeat(64) } })))._tag,"Failure");
      } else assert.equal((yield* Effect.result(store.registry.entries.enter({ entry: next.entry, root: next.root, oids: next.oids })))._tag,"Failure");
    }));
  }
});

test("O67: confirmed proof releases undelivered orders atomically while fulfilled delivery and price reserve stay sticky", async (t) => {
  const f = supersessionFixture(t);
  await use(f, store => Effect.gen(function* () {
    const { tokens, input } = yield* f.prepare(store, true);
    for (const bad of [{ rootAbsent: false }, { confirm: "0".repeat(32) }, { height: 299 }, { revision: 1 }, { txid: input.conflictTxid }])
      assert.equal((yield* Effect.result(store.registry.supersessions.accept({ ...input, ...bad })))._tag, "Failure");
    f.control.valid = false;
    assert.equal((yield* Effect.result(store.registry.supersessions.accept(input)))._tag, "Failure"); f.control.valid = true;
    const before = yield* store.inspectionOrder("o1"), receipt = yield* store.registry.supersessions.accept(input);
    assert.equal(receipt.acknowledged, true); assert.equal(receipt.proof!.active, true); assert.equal("originalRaw" in receipt.proof!, false);
    assert.equal((yield* store.order(tokens[0]!)).status, "fulfilled"); assert.equal((yield* store.order(tokens[1]!)).status, "converted");
    assert.equal((yield* store.inspectionOrder("o1")).price_reserve, before.price_reserve);
    assert.deepEqual((yield* store.inspectionOrder("o1")).fulfillment, before.fulfillment);
    assert((yield* store.order(tokens[0]!)).recovery_incident!.reasons.includes("superseded"));
    const entry = yield* store.registry.entries.find({ entry: armed.entry, root: armed.root, oids: armed.oids }); assert.equal(entry.found, true); if (entry.found) assert.equal(entry.batchable, false);
    assert.equal((yield* Effect.result(store.registry.certificates.accept(f.packet())))._tag, "Failure");
    assert.equal((yield* Effect.result(store.registry.commitments.observe({ ...armed, expectedRevision: 2, observation: f.facts(50,50,300) })) )._tag, "Failure");
  }));
});
test("O73: a rebatched certificate starts its own revision and later proof reversal preserves its first fulfilled receipt", async (t) => {
  const f = supersessionFixture(t);
  await use(f, store => Effect.gen(function* () {
    const p = yield* f.prepare(store); yield* store.registry.supersessions.accept(p.input);
    const next = { entry: "8".repeat(32), root: "9".repeat(64), oids: ["o1", "o2"], delegate: "2".repeat(64) + ":0" };
    yield* store.registry.entries.enter({ entry: next.entry, root: next.root, oids: next.oids }); yield* store.registry.entries.arm(next);
    f.node.tip = 500; f.chain.hash = "e".repeat(64);
    yield* store.registry.commitments.observe({ ...next, expectedRevision: 0,
      observation: { ...f.facts(310,310,500), txid: "b".repeat(64) } });
    const certificate = yield* store.registry.certificates.accept({ ...next, oid: "o1", revision: 1,
      certificateRoot: next.root, certificateHeight: 310, message_b64: f.message.toString("base64") });
    assert.equal(certificate.acknowledged, true);
    yield* store.registry.deliveries.fulfill({ ...next, oid: "o1", revision: 1, certificateHash: certificate.hash,
      relayRoot: next.root, relayHeight: 310, proofHash: "7".repeat(64) });
    const before = (yield* store.inspectionOrder("o1")).fulfillment;
    f.control.valid = false; f.chain.hash = "f".repeat(64); yield* store.observe();
    assert.equal((yield* store.order(p.tokens[0]!)).status, "fulfilled");
    assert.deepEqual((yield* store.inspectionOrder("o1")).fulfillment, before);
    assert((yield* store.order(p.tokens[0]!)).recovery_incident!.reasons.includes("supersession_reversed"));
    assert.equal((yield* Effect.result(store.certificate(p.tokens[0]!)))._tag, "Failure");
  }));
});
test("O68: proof reversal relocks paid orders and records incidents for cancelled or rebatching orders without undoing their history", async (t) => {
  for (const mode of ["paid", "cancelled", "rebatching"]) {
    const f = supersessionFixture(t); let token = "";
    await use(f, store => Effect.gen(function* () {
      const p = yield* f.prepare(store); token = p.tokens[0]!; yield* store.registry.supersessions.accept(p.input);
      if (mode === "cancelled") yield* store.cancel(token);
      const next = { entry: "8".repeat(32), root: "9".repeat(64), oids: ["o1", "o2"] };
      if (mode === "rebatching") yield* store.registry.entries.enter(next);
      f.control.valid = false; f.chain.hash = "d".repeat(64); yield* store.observe();
      const view = yield* store.order(token);
      assert.equal(view.status, mode === "cancelled" ? "cancelled" : "issuing");
      assert.equal(!!view.recovery_incident, mode !== "paid");
      if (mode === "rebatching") {
        assert.equal((yield* Effect.result(store.registry.entries.arm({ ...next, delegate: armed.delegate })) )._tag, "Failure");
        yield* store.registry.entries.close(next);
        assert.equal((yield* store.order(token)).status, "issuing");
      }
      if (mode === "paid") assert.equal((yield* Effect.result(store.cancel(token)))._tag, "Failure");
    }));
    await use(f, store => Effect.gen(function* () {
      const status = yield* store.registry.supersessions.current(armed); assert.equal(status.proof!.active, false);
      assert.equal((yield* store.order(token)).status, mode === "cancelled" ? "cancelled" : "issuing");
    }));
  }
});
test("O69: unknown RPC or journal outcomes never manufacture a second proof and startup requires a chain verifier", async (t) => {
  const f = supersessionFixture(t); let packet: unknown;
  await use(f, store => Effect.gen(function* () {
    packet = (yield* f.prepare(store)).input;
    f.journal.down = true;
    const first = yield* store.registry.supersessions.accept(packet); assert.equal(first.acknowledged, false);
    f.journal.down = false; assert.equal((yield* store.registry.supersessions.accept(packet)).acknowledged, true);
    const db = new DatabaseSync(f.config.database, { readOnly: true });
    try {
      const before = db.prepare("select * from records order by kind,key").all(); f.control.down = true;
      assert.equal((yield* Effect.result(store.observe()))._tag, "Failure");
      assert.deepEqual(db.prepare("select * from records order by kind,key").all(), before);
    } finally { db.close(); }
  }));
  await assert.rejects(use(f, () => Effect.void)); f.control.down = false;
  delete f.adapters.supersessionChain;
  await assert.rejects(use(f, () => Effect.void), /supersession chain adapter required/);
});
test("O70: revoked proof retries never reactivate it and fresh original verification can recover a relocked sale", async (t) => {
  const f = supersessionFixture(t);
  await use(f, store => Effect.gen(function* () {
    const p = yield* f.prepare(store); yield* store.registry.supersessions.accept(p.input);
    f.control.valid = false; yield* store.observe(); f.control.valid = true;
    assert.equal((yield* store.registry.supersessions.accept(p.input)).proof!.active, false);
    assert.equal((yield* Effect.result(store.registry.supersessions.accept({ ...p.input, conflictTxid: "1".repeat(64) })))._tag, "Failure");
    const report = yield* store.registry.commitments.observe({ ...armed, expectedRevision: 2, observation: f.facts(50,50,300) });
    yield* store.registry.certificates.accept(f.packet("o1", report.revision));
    assert.equal((yield* store.order(p.tokens[0]!)).status, "ready");
  }));
});
test("O75: a fresh explicit decision after reversal appends proof history and can release unambiguous original members again", async (t) => {
  const f = supersessionFixture(t);
  await use(f, store => Effect.gen(function* () {
    const p = yield* f.prepare(store); yield* store.registry.supersessions.accept(p.input);
    f.control.valid = false; yield* store.observe(); f.control.valid = true;
    f.node.tip = 301; f.chain.hash = "e".repeat(64);
    const report = yield* store.registry.commitments.observe({ ...armed, expectedRevision: 2, observation: f.facts(null,null,301) });
    const next = { ...p.input, revision: report.revision, tipHeight: f.node.tip, tipHash: f.chain.hash };
    assert.equal((yield* store.registry.supersessions.accept(next)).proof!.active, true);
    assert.equal((yield* store.order(p.tokens[0]!)).status, "converted");
    const db = new DatabaseSync(f.config.database, { readOnly: true });
    try { assert.equal(db.prepare("select count(*) as n from records where kind='supersession'").get()!.n, 2); } finally { db.close(); }
    yield* store.cancel(p.tokens[0]!); f.control.valid = false; yield* store.observe(); f.control.valid = true;
    const newer = yield* store.registry.commitments.observe({ ...armed, expectedRevision: report.revision,
      observation: f.facts(null,null,301) });
    // A direct privileged callback cannot bypass the attended command's
    // cancelled-member recovery restriction.
    assert.equal((yield* Effect.result(store.registry.supersessions.accept({ ...next, revision: newer.revision })))._tag, "Failure");
  }));
});
test("O71: corrupted supersession relationships refuse startup while preserving their authoritative journal", async (t) => {
  const f = supersessionFixture(t);
  await use(f, store => Effect.gen(function* () { const p = yield* f.prepare(store); yield* store.registry.supersessions.accept(p.input); }));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* DurableStore.open(f.config), rows = yield* store.records();
    const proof = rows.find(r => r.kind === "supersession")!;
    yield* store.commit([{ ...proof, value: { ...(proof.value as object), txid: "b".repeat(64) } }]);
  })));
  const before = f.journal.read().length;
  await assert.rejects(use(f, () => Effect.void), /invalid supersession relationship/);
  assert.equal(f.journal.read().length, before);
});
test("O72: supersession HTTP is authenticated, exact, hides signed bytes and recovers a lost acknowledgment", async (t) => {
  const f = supersessionFixture(t);
  await use(f, store => Effect.gen(function* () {
    const p = yield* f.prepare(store), listener = yield* serveOperator(store, Effect.succeed(credential));
    const proxy = yield* Effect.promise(() => faultProxy(t, listener.url));
    const post = (raw: string, token = credential) => fetch(proxy.url + "/operator/supersessions", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: raw });
    yield* Effect.promise(async () => {
      const valid = JSON.stringify(p.input);
      assert.equal((await post(valid, "incorrect")).status, 401);
      for (const raw of [valid.replace('"confirm":', '"extra":'), valid.replace('"rootAbsent":true','"rootAbsent":false'),
        valid.replace('"originalRaw":', '"original\\u0052aw":'), valid.replace('{','{"confirm":"0",'), " ".repeat(1_048_577)])
        assert.equal((await post(raw)).status, 400);
      proxy.control.afterPath = "/operator/supersessions"; await assert.rejects(post(valid));
      const recovered = await post(valid); assert.equal(recovered.status, 200);
      const receipt = await recovered.json() as { proof: { active: boolean }; acknowledged: boolean };
      assert.equal(receipt.proof.active, true); assert.equal(receipt.acknowledged, true);
      assert.equal(JSON.stringify(receipt).includes('"originalRaw"'), false);
    });
  }));
});
