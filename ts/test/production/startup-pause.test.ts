// Copy to ts/test/production after adding Config.startupPause and v2 wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { SalesStore } from '../../src/application/store.ts';
import { fixture, invoice, payment, setup, use } from './application-fixture.ts';

test('O152: a cold v2 start journals pause and closes an undetected prior payment prompt without extending its hold', async (t) => {
  const f = fixture(t); let token = '';
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); token = one.token;
    assert.equal(one.quote.payment_request_open, true);
    assert.equal(one.quote.hold_expires_at, 900);
  }));
  // The payment may have existed while the host was unavailable. This fixture
  // supplies no durable detection and makes no claim about a mempool timestamp.
  f.node.now = 200;
  const config = { ...f.config, startupPause: true };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* SalesStore.open(config, f.adapters);
    const history = f.journal.read();
    const values = new Map(history.flatMap(e => e.changes.map(c => [c.kind + '/' + c.key, c.value] as const)));
    assert.equal((values.get('sales_settings/global') as { paused: boolean }).paused, true);
    assert.equal((values.get('sales_order/o1') as { paymentHistory: string }).paymentHistory, 'unknown');
    assert.equal(values.has('application_recovery/global'), false);
    const view = yield* store.order(token);
    assert.equal(view.payment_history, 'unknown'); assert.equal(view.address, null);
    assert.equal(view.payment_request_open, false); assert.equal(view.hold_expires_at, 900);
    assert.equal((yield* store.operatorStatus()).unknown_payment_history, 1);
    yield* store.pause(false); // Explicit operator review does not revive this prompt.
    assert.equal((yield* store.order(token)).payment_request_open, false);
  })));
});

test('O152: unavailable journal refuses the startup barrier before observation and retries its exact durable pause', async (t) => {
  const f = fixture(t); let token = '';
  await use(f, store => Effect.gen(function* () { yield* setup(store); token = (yield* invoice(store)).token; }));
  const observations = f.node.observations, draws = f.node.draws;
  f.journal.down = true;
  await assert.rejects(Effect.runPromise(Effect.scoped(SalesStore.open({ ...f.config, startupPause: true }, f.adapters))));
  assert.equal(f.node.observations, observations); assert.equal(f.node.draws, draws);
  f.journal.down = false;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* SalesStore.open({ ...f.config, startupPause: true }, f.adapters);
    const view = yield* store.order(token);
    assert.equal(view.payment_history, 'unknown'); assert.equal(view.payment_request_open, false);
  })));
});

test('O152: persisted detections and conversion count survive the startup pause', async (t) => {
  const f = fixture(t); let token = '';
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); token = (yield* invoice(store)).token;
    f.node.outputs = [payment(1)]; yield* store.observe();
  }));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* SalesStore.open({ ...f.config, startupPause: true }, f.adapters);
    const view = yield* store.order(token);
    assert.equal(view.payment_history, 'detected'); assert.equal(view.status, 'converted');
    const status = yield* store.operatorStatus(); assert.equal(status.paused, true); assert.equal(status.unknown_payment_history, 0);
  })));
});
