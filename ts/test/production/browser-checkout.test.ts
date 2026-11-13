import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { serve } from "../../src/application/http.ts";
import { serveOperator } from "../../src/application/operator-http.ts";
import { btc } from "../../src/application/checkout.ts";
import { SalesStore } from "../../src/application/store.ts";
import { restoreApplication } from "../../src/application/recovery.ts";
import { ApplicationError } from "../../src/application/records.ts";
import { DurableStore } from "../../src/storage/store.ts";
import type { Json } from "../../src/storage/codec.ts";
import { CERTIFICATE_LIMIT } from "../../src/application/certificate-cache.ts";
import { fixture, invoice, payment, script, setup, use } from "./application-fixture.ts";
import { certificateFixture } from "./certificate-fixture.ts";
import { sendingFixture, tipHash } from "./refund-sending-fixture.ts";
import { armed } from "./commitment-fixture.ts";
import { credential } from "./entry-http-fixture.ts";
import { controllerFixture } from "./reconciliation-fixture.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const scoped = <A, E>(effect: Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));
const recipient = (handle = "n0@space") => JSON.stringify({ handle, script_pubkey: script });
async function page(url: string) { const response = await fetch(url); return { response, html: await response.text() }; }
async function post(url: string, field?: string, value = "") {
  return fetch(url, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: field ? new URLSearchParams({ [field]: value }).toString() : "" });
}
function noPayment(html: string) { assert.doesNotMatch(html, /id="(?:bip21|payment_request|amount_btc)"/); assert.match(html.replace(/&#39;/g, "'"), /(?:[Dd]on't|do not) (?:pay|send)/); }
function privateHeaders(response: Response) {
  assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy")!, /script-src 'none'/); assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}
function declared(url: string, size: number, authenticated = false) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers: { "Content-Length": size, "Content-Type": "application/x-www-form-urlencoded", Connection: "close",
      ...(authenticated ? { Authorization: `Bearer ${credential}` } : {}) } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode!));
    }); request.on("error", reject); request.end("x");
  });
}

test("C1: the public catalog gives fixed prices and current availability without private order data", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store, 2); const one = yield* invoice(store), listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const { html } = await page(listener.url);
      assert.match(html, /n0@space/); assert.match(html, /n1@space/); assert.match(html, /1,000 sats/);
      assert.match(html, /data-handle="n0@space" data-available="false"/); assert.match(html, /data-handle="n1@space" data-available="true"/);
      for (const secret of [one.token, one.quote.address!, script, "tokenHash", "o1"]) assert(!html.includes(secret));
      f.node.now = 900; assert.match((await page(listener.url)).html, /data-handle="n0@space" data-available="true"/);
    });
  }));
});
test("C2: a complete public request creates a private order through the browser with a 303 redirect", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store, 2); const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      assert.match((await page(listener.url + "/buy/n0@space")).html, /textarea[^>]+name="request"/);
      const response = await post(listener.url + "/buy/n0@space", "request", recipient());
      assert.equal(response.status, 303); privateHeaders(response);
      const location = response.headers.get("location")!; assert.match(location, /^\/o\/[A-Za-z0-9_-]{32}$/);
      const order = await page(listener.url + location); assert.equal(order.response.status, 200); assert.match(order.html, /id="status">requested/);
      assert.match(order.html, /Get the invoice/); assert.match(order.html, /private link/);
    });
    assert.equal((yield* store.inspectionOrders()).orders.length, 1);
  }));
});
test("C3: malformed, secret-bearing, duplicate and mismatched requests are refused without echo or persistence", async (t) => {
  const f = fixture(t), placeholder = "placeholder-secret-9dd2";
  await use(f, store => Effect.gen(function* () {
    yield* setup(store, 2); const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const valid = recipient();
      const invalid = ["<script>" + placeholder + "</script>", JSON.stringify({ handle: "n0@space", script_pubkey: script, seed: placeholder }),
        recipient("n1@space"), recipient("N0@space"), valid.replace(script, "5120" + "f".repeat(64)),
        valid.replace('"handle":', '"handle":"n0@space","h\\u0061ndle":'), '{"handle":"n0@space","script_pubkey":4}', valid + "junk"];
      for (const raw of invalid) {
        const result = await post(listener.url + "/buy/n0@space", "request", raw), html = await result.text();
        assert.equal(result.status, 400); assert(!html.includes(placeholder)); assert(!html.includes(script)); assert(!html.includes("<script>"));
      }
      for (const raw of ["request=x&request=y", "request=%ff", "request=%zz", "other=x", "request=x=y", "request=x&"]) {
        const response = await fetch(listener.url + "/buy/n0@space", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: raw });
        assert.equal(response.status, 400);
      }
    });
    assert.equal((yield* store.inspectionOrders()).orders.length, 0);
  }));
});
test("C4: acknowledged invoices render exact decimal BTC and BIP21 through the production quote command", async (t) => {
  assert.equal(btc(1), "0.00000001"); assert.equal(btc(100_000_000), "1"); assert.equal(btc(21_000_000 * 100_000_000), "21000000");
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const link = yield* store.request(JSON.parse(recipient())), listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const response = await post(`${listener.url}/o/${link.token}/invoice`); assert.equal(response.status, 303);
      const { html } = await page(`${listener.url}/o/${link.token}`);
      assert.match(html, /id="price_sats">1000/); assert.match(html, /id="address">mock-address-1/);
      assert.match(html, /href="bitcoin:mock-address-1\?amount=0.00001"/); assert.match(html, /up to 200 sats/); assert.match(html, /546 sats/);
    });
  }));
});
test("C5: journal outages withhold browser payment addresses and retry the same recorded destination", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const link = yield* store.request(JSON.parse(recipient())), listener = yield* serve(store);
    yield* Effect.promise(async () => {
      f.journal.down = true; let response = await post(`${listener.url}/o/${link.token}/invoice`);
      assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /mock-address/); assert.equal(f.node.draws, 0);
      f.journal.down = false; f.node.beforeDestination = async () => { f.journal.down = true; };
      response = await post(`${listener.url}/o/${link.token}/invoice`); assert.equal(response.status, 503);
      const html = await response.text(); assert.match(html, /Try again/); assert.doesNotMatch(html, /mock-address|id="invoice_history"/); assert.equal(f.node.draws, 1);
      f.node.beforeDestination = null; f.journal.down = false;
      assert.equal((await post(`${listener.url}/o/${link.token}/invoice`)).status, 303);
      assert.match((await page(`${listener.url}/o/${link.token}`)).html, /id="address">mock-address-1/); assert.equal(f.node.draws, 1);
    });
  }));
});
test("C6: private tokens reveal only their own order and malformed or absent tokens give the same 404", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const first = yield* invoice(store), second = yield* invoice(store, 1), listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const own = (await page(`${listener.url}/o/${first.token}`)).html;
      assert.match(own, /n0@space/); assert(!own.includes(second.token)); assert(!own.includes("n1@space")); assert(!own.includes(second.quote.address!));
      const other = (await page(`${listener.url}/o/${second.token}`)).html; assert.match(other, /n1@space/); assert(!other.includes("n0@space"));
      let missing = "";
      for (const token of ["x".repeat(32), "o1", first.token + "extra", "malformed%2ftoken"]) {
        const view = await page(`${listener.url}/o/${token}`); assert.equal(view.response.status, 404);
        if (missing) assert.equal(view.html, missing); missing = view.html;
        assert(!view.html.includes(script));
      }
    });
  }));
});
test("C7: unbound converted orders cannot accept certificates and verified bound readiness enables exact browser download", async (t) => {
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const link = yield* invoice(store); f.node.outputs = [payment(1)];
    assert.equal((yield* store.order(link.token)).status, "converted");
    yield* Effect.promise(() => assert.rejects(run(store.registry.certificates.accept(f.packet()))));
    assert.equal((yield* store.order(link.token)).certificate_available, false);
  }));
  const ready = certificateFixture(t);
  await use(ready, store => Effect.gen(function* () {
    const tokens = yield* ready.prepare(store), listener = yield* serve(store);
    yield* store.registry.certificates.accept(ready.packet());
    yield* Effect.promise(async () => {
      const { html } = await page(`${listener.url}/o/${tokens[0]}`); assert.match(html, /id="certificate"/);
      const download = await fetch(`${listener.url}/o/${tokens[0]}/certificate`); assert.equal(download.status, 200); privateHeaders(download);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), ready.message);
    });
  }));
});
test("C8: finality loss withdraws both certificate link and bytes until a fresh final observation is verified", async (t) => {
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    const tokens = yield* f.prepare(store), listener = yield* serve(store); yield* store.registry.certificates.accept(f.packet());
    yield* store.registry.commitments.observe({ ...armed, expectedRevision: 1, observation: f.facts(50, null, 210) });
    yield* Effect.promise(async () => {
      assert.doesNotMatch((await page(`${listener.url}/o/${tokens[0]}`)).html, /id="certificate"/);
      assert.equal((await fetch(`${listener.url}/o/${tokens[0]}/certificate`)).status, 404);
    });
    yield* store.registry.commitments.observe({ ...armed, expectedRevision: 2, observation: f.facts(50, 50, 210) });
    yield* store.registry.certificates.accept(f.packet("o1", 3));
    yield* Effect.promise(async () => assert.match((await page(`${listener.url}/o/${tokens[0]}`)).html, /id="certificate"/));
  }));
});
test("C9: every browser response is private, scriptless, unframeable and escapes adapter-supplied text", async (t) => {
  const f = sendingFixture(t), injected = '<img src=x onerror="alert(1)">&';
  f.adapters.newDestination = Effect.succeed({ address: injected, script: "0014" + "1".repeat(40) });
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const link = yield* invoice(store), listener = yield* serve(store);
    yield* store.setRefundDestination(link.token, injected);
    yield* Effect.promise(async () => {
      for (const path of ["/", "/buy/n0@space", "/o/" + link.token, "/o/missing", "/buy/Bad@space"]) {
        const { response, html } = await page(listener.url + path); privateHeaders(response);
        assert.doesNotMatch(html, /<script[\s>]|<img|onerror="/);
        if (path === "/o/" + link.token) assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;/);
      }
      privateHeaders(await post(`${listener.url}/o/${link.token}/cancel`));
      privateHeaders(await post(listener.url + "/buy/n0@space", "request", "bad"));
    });
  }));
});
test("C10: kept large certificate bytes retain exact download while authenticated delivery alone gets the larger body bound", async (t) => {
  const bytes = readFileSync(new URL("../../../regtest/evidence/combined-20261107T113909Z-345992/017-b7/five@test10000.message.bin", import.meta.url));
  assert.equal(bytes.length, 226_511);
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    const tokens = yield* f.prepare(store), listener = yield* serve(store), operator = yield* serveOperator(store, Effect.succeed(credential));
    yield* Effect.promise(async () => {
      const send = (raw: string, authenticated = true) => fetch(operator.url + "/operator/certificates", { method: "POST", headers: authenticated ? { Authorization: `Bearer ${credential}` } : {}, body: raw });
      const packet = JSON.stringify(f.packet("o1", 1, armed.root, 50, bytes));
      assert.equal((await send(packet, false)).status, 401); assert.equal((await send(packet)).status, 200);
      assert.equal((await send(JSON.stringify(f.packet("o1", 1, armed.root, 50, Buffer.alloc(CERTIFICATE_LIMIT + 1))))).status, 400);
      assert.equal(await declared(operator.url + "/operator/certificates", 4 * Math.ceil(CERTIFICATE_LIMIT / 3) + 65_537), 401);
      assert.equal(await declared(operator.url + "/operator/certificates", 4 * Math.ceil(CERTIFICATE_LIMIT / 3) + 65_537, true), 400);
      for (const path of ["/requests", "/buy/n0@space", `/o/${tokens[0]}/invoice`, `/o/${tokens[0]}/cancel`, `/o/${tokens[0]}/refund-address`]) {
        const response = await fetch(listener.url + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "x".repeat(65_537) });
        assert.equal(response.status, 400); assert.equal(await declared(listener.url + path, 65_537), 400);
      }
      assert.equal((await fetch(operator.url + "/operator/observe", { method: "POST", headers: { Authorization: `Bearer ${credential}` }, body: "x".repeat(65_537) })).status, 400);
      const request = JSON.stringify({ handle: "n3@space", script_pubkey: "5120" + "3".padStart(64, "0") }), raw = "request=" + encodeURIComponent(request);
      assert.equal((await fetch(listener.url + "/buy/n3@space", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: raw + "+".repeat(65_536 - Buffer.byteLength(raw)) })).status, 303);
      const result = await fetch(`${listener.url}/o/${tokens[0]}/certificate`); assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
    });
    assert.equal((yield* store.inspectionOrders()).orders.length, 3);
  }));
});
test("C11: payment requests close for confirmation, issuance, cancellation, expiry and short payment", async (t) => {
  for (const scenario of ["confirmed", "cancelled", "pending-cancel", "expired", "expired-short"]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* setup(store); const link = yield* invoice(store), listener = yield* serve(store);
      yield* Effect.promise(async () => assert.match((await page(`${listener.url}/o/${link.token}`)).html, /id="bip21"/));
      if (scenario === "confirmed") f.node.outputs = [payment(1, 1000, 1)];
      if (scenario === "cancelled" || scenario === "pending-cancel") { f.journal.down = scenario === "pending-cancel"; yield* store.cancel(link.token); }
      if (scenario.startsWith("expired")) { f.node.now = 900; f.node.tip = 17; if (scenario === "expired-short") f.node.outputs = [payment(1, 100, 1)]; }
      yield* Effect.promise(async () => noPayment((await page(`${listener.url}/o/${link.token}`)).html));
      if (scenario === "confirmed") {
        f.node.outputs = [payment(1)]; assert.equal((yield* store.order(link.token)).status, "converted");
        yield* Effect.promise(async () => noPayment((await page(`${listener.url}/o/${link.token}`)).html));
        yield* store.beginIssuance("o1"); yield* Effect.promise(async () => noPayment((await page(`${listener.url}/o/${link.token}`)).html));
      }
      f.journal.down = false;
    }));
  }
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    const tokens = yield* f.prepare(store), listener = yield* serve(store); yield* store.registry.certificates.accept(f.packet());
    yield* Effect.promise(async () => noPayment((await page(`${listener.url}/o/${tokens[0]}`)).html));
    const cert = yield* store.registry.deliveries.status({ ...armed, oid: "o1" });
    yield* store.registry.deliveries.fulfill({ ...armed, oid: "o1", revision: cert.revision, certificateHash: cert.certificateHash!, relayRoot: armed.root, relayHeight: 50, proofHash: "e".repeat(64) });
    yield* Effect.promise(async () => noPayment((await page(`${listener.url}/o/${tokens[0]}`)).html));
  }));
});
test("C11: pilot pay-first invoices disclose race and fee before the address and stop asking at quote expiry", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); for (let i = 0; i < 10; i++) yield* invoice(store, i);
    const link = yield* invoice(store, 10), listener = yield* serve(store); assert.equal(link.quote.pay_first, true);
    yield* Effect.promise(async () => {
      const html = (await page(`${listener.url}/o/${link.token}`)).html;
      assert.match(html, /id="bip21"/); assert.match(html, /does not reserve the name/);
      assert(html.indexOf('id="pay_first_warning"') < html.indexOf('id="address"')); assert(html.indexOf("up to 200 sats") < html.indexOf('id="address"'));
      f.node.now = 900; noPayment((await page(`${listener.url}/o/${link.token}`)).html);
      await run(store.listName("n10@space", 900)); f.node.outputs = [payment(11)];
      const view = await run(store.order(link.token)); assert.equal(view.price_sats, 900); assert.equal(view.quoted_price_sats, 1000);
      const history = (await page(`${listener.url}/o/${link.token}`)).html; noPayment(history); assert.match(history, /id="invoice_price_sats">1000/);
    });
  }));
});
test("C12: mempool, partial, lost and replaced payments never invite another payment or count as confirmed", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store), listener = yield* serve(store);
    yield* Effect.promise(async () => {
      f.node.outputs = [payment(1, 1000, 0)]; let html = (await page(`${listener.url}/o/${one.token}`)).html;
      noPayment(html); assert.match(html, /Payment detected, awaiting confirmation/);
      let v = await run(store.order(one.token)); assert.equal(v.confirmed_sats, 0); assert.equal(v.batchable_sats, 0); assert.equal(v.status, "quoted");
      f.node.outputs = [{ ...payment(1, 100, 0), outpoint: "replacement-paying" }]; html = (await page(`${listener.url}/o/${one.token}`)).html;
      noPayment(html); assert.match(html, /Partial payment detected, awaiting confirmation: 100 of 1,000 sats/);
      f.node.outputs = [{ ...payment(2, 100, 0), outpoint: "replacement-not-paying" }]; html = (await page(`${listener.url}/o/${one.token}`)).html;
      noPayment(html); assert.match(html, /dropped or replaced/); assert.match(html, /can still confirm/);
      f.node.now = 900; f.node.tip = 17; html = (await page(`${listener.url}/o/${one.token}`)).html;
      noPayment(html); assert.match(html, /late payment/); v = await run(store.order(one.token)); assert.equal(v.status, "unpaid");
      assert.equal(v.payment_history, "detected"); assert.equal(v.detected_sats, 0); assert.equal(v.hold_expires_at, null);
    });
  }));
  const confirmed = fixture(t);
  await use(confirmed, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store), listener = yield* serve(store);
    confirmed.node.outputs = [payment(1, 1000, 0)]; yield* store.order(one.token);
    confirmed.node.outputs = [payment(1, 1000, 1)]; assert.equal((yield* store.order(one.token)).status, "quoted");
    confirmed.node.outputs = [payment(1)];
    yield* Effect.promise(async () => { noPayment((await page(`${listener.url}/o/${one.token}`)).html); assert.equal((await run(store.order(one.token))).status, "converted"); });
  }));
});
test("C12: journal-only recovery retains durable detection and treats lost or never-observed invoice histories as unknown", async (t) => {
  const f = fixture(t), tokens: string[] = [];
  f.adapters.snapshot = () => Effect.succeed({ tip: f.node.tip, tipHash, outputs: structuredClone(f.node.outputs) });
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); for (let i = 0; i < 3; i++) tokens.push((yield* invoice(store, i)).token);
    tokens.push((yield* store.request({ handle: "n3@space", script_pubkey: script })).token);
    yield* store.order(tokens[3]!); // acknowledge the unquoted order
    f.node.outputs = [payment(1, 1000, 0)]; yield* store.order(tokens[0]!);
    f.node.outputs = []; yield* store.order(tokens[0]!);
    f.journal.down = true; f.node.outputs = [payment(2, 100, 0)]; assert.equal((yield* store.order(tokens[1]!)).payment_history, "detected");
  }));
  f.journal.down = false; f.node.outputs = [];
  const config = { ...f.config, database: join(f.root, "restored.db") };
  await scoped(restoreApplication(config)); await scoped(SalesStore.reconcileRecovery(config, f.adapters, controllerFixture().controller));
  await use({ ...f, config }, store => Effect.gen(function* () {
    const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      for (const index of [0, 1, 2]) {
        const view = await run(store.order(tokens[index]!)), html = (await page(`${listener.url}/o/${tokens[index]}`)).html;
        assert.equal(view.payment_history, index === 0 ? "detected" : "unknown"); noPayment(html);
        assert.match(html, index === 0 ? /detected earlier/ : /cannot tell whether a payment was sent/);
      }
      const html = (await page(`${listener.url}/o/${tokens[3]}`)).html; assert.match(html, /Get the invoice/);
      assert.equal((await run(store.order(tokens[3]!))).payment_history, "none");
      f.node.now = 900; f.node.tip = 17;
      for (const token of tokens.slice(0, 3)) { const html = (await page(`${listener.url}/o/${token}`)).html; noPayment(html); assert.match(html, /late payment/); }
      f.node.outputs = [payment(2, 100, 0)]; assert.equal((await run(store.order(tokens[1]!))).payment_history, "detected");
      f.node.outputs = []; assert.equal((await run(store.order(tokens[1]!))).payment_history, "detected");
    });
  }));
});
test("C12: unsupported pre-history TypeScript records refuse startup and restore without a partial schema migration", async (t) => {
  for (const historicalPayment of [false, true]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () { yield* setup(store); yield* invoice(store); if (historicalPayment) { f.node.outputs = [payment(1, 100, 0)]; yield* store.observe(); } }));
    await scoped(Effect.gen(function* () {
      const storage = yield* DurableStore.open(f.config), value = structuredClone((yield* storage.get("sales_order", "o1"))!.value) as { [key: string]: Json };
      delete value.paymentHistory; yield* storage.commit([{ kind: "sales_order", key: "o1", value }]); yield* storage.flush();
    }));
    const before = f.journal.read();
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(use(f, () => Effect.void), /invalid stored fields/);
      const config = { ...f.config, database: join(f.root, `unsupported-${attempt}.db`) };
      await assert.rejects(scoped(restoreApplication(config)), /invalid stored fields/);
      assert.equal(existsSync(config.database), false);
    }
    assert.deepEqual(f.journal.read(), before);
    await scoped(Effect.gen(function* () {
      const storage = yield* DurableStore.open(f.config), value = (yield* storage.get("sales_order", "o1"))!.value as { [key: string]: Json };
      assert.equal("paymentHistory" in value, false);
    }));
  }
});
test("C12: a chain outage never turns an order page into a replacement payment request", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const link = yield* invoice(store), listener = yield* serve(store);
    f.adapters.snapshot = () => Effect.fail(new ApplicationError({ code: "unavailable", message: "untrusted RPC details" }));
    yield* Effect.promise(async () => {
      const view = await page(`${listener.url}/o/${link.token}`); assert.equal(view.response.status, 503); privateHeaders(view.response);
      assert.doesNotMatch(view.html, /untrusted RPC details|mock-address|id="bip21"/); assert.match(view.html, /do not send another/);
    });
  }));
});
test("K10: browser cancellation and refund destination use production acknowledgment and attended refund status", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const link = yield* invoice(store), listener = yield* serve(store);
    f.node.outputs = [{ ...payment(1, 10000, 6), outpoint: "1".repeat(64) + ":0" }];
    yield* Effect.promise(async () => {
      assert.equal((await post(`${listener.url}/o/${link.token}/refund-address`, "address", "buyer-refund")).status, 303);
      assert.match((await page(`${listener.url}/o/${link.token}`)).html, /id="refund_address">buyer-refund/);
      f.journal.down = true; const pending = await post(`${listener.url}/o/${link.token}/cancel`); assert.equal(pending.status, 202);
      noPayment(await pending.text()); f.journal.down = false;
      assert.equal((await post(`${listener.url}/o/${link.token}/cancel`)).status, 303);
    });
    const refund = yield* store.prepareOperatorRefund("o1", "cancellation", "buyer"); yield* store.broadcastOperatorRefund(refund.id, refund.txid!);
    yield* Effect.promise(async () => { const html = (await page(`${listener.url}/o/${link.token}`)).html; assert.match(html, /9,800 sats to you/); assert.match(html, /200 sats network fee/); assert.match(html, /mempool/); });
    f.observations.set(refund.txid!, { txid: refund.txid!, seen: "mined", confirmations: 6, blockHash: tipHash, inputsAvailable: false, conflicts: [] });
    yield* Effect.promise(async () => assert.match((await page(`${listener.url}/o/${link.token}`)).html, /Refund status: <strong>settled/));
  }));
});
