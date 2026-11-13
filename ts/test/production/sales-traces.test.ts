import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { Pilot } from "../../model/pilot.ts";
import { validP2tr } from "../../src/recipient.ts";
import { fixture, payment, setup, use } from "./application-fixture.ts";

test("seeded application traces agree with the independent pilot model on supported sales rules", async (t) => {
  const f = fixture(t, 10_000), model = new Pilot(10_000);
  const recipients: string[] = [];
  for (let x = 1; recipients.length < 20; x++) {
    const script = "5120" + x.toString(16).padStart(64, "0");
    if (validP2tr(script)) recipients.push(script);
  }
  let seed = 73, requests = 0, conversions = 0;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const links = new Map<number, { token: string; id: string; destination: number }>();
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  async function outcome<A, E>(effect: Effect.Effect<A, E>) {
    try { return { ok: true as const, value: await run(effect) }; }
    catch { return { ok: false as const }; }
  }
  await use(f, store => Effect.promise(async () => {
    await run(setup(store));
    for (let i = 0; i < 20; i++) model.price(`n${i}@space`, 1_000);
    for (let step = 0; step < 200; step++) {
      const before = model.snapshot(), selected = before.orders[random(Math.max(before.orders.length, 1))];
      const link = selected && links.get(selected.id)!;
      switch (random(5)) {
        case 0: {
          const handle = random(20);
          const request = await run(store.request({ handle: `n${handle}@space`, script_pubkey: recipients[handle]! }));
          const sequence = ++requests;
          let expected;
          try { expected = model.quote(`n${handle}@space`, sequence); } catch { expected = null; }
          const actual = await outcome(store.quote(request.token));
          assert.equal(actual.ok, !!expected, `quote at trace step ${step}`);
          if (expected && actual.ok) {
            assert.equal(actual.value.pay_first, expected.payFirst);
            links.set(expected.id, { token: request.token, id: `o${sequence}`, destination: f.node.draws });
          }
          break;
        }
        case 1: if (selected && link) {
          let expected = true; try { model.cancel(selected.id); } catch { expected = false; }
          assert.equal((await outcome(store.cancel(link.token))).ok, expected, `cancel at trace step ${step}`);
        } break;
        case 2: if (selected && link) {
          let expected = true; try { model.beginIssuance(selected.id); } catch { expected = false; }
          assert.equal((await outcome(store.beginIssuance(link.id))).ok, expected, `issuance at trace step ${step}`);
        } break;
        case 3: model.pause(false); await run(store.pause(false)); break;
        case 4: {
          f.node.now += random(1200); f.node.tip++;
          const outputs = before.orders.filter(() => random(3) > 0).map(o => ({
            id: `trace-output-${o.id}`, order: o.id, sats: o.id % 4 ? 1_000 : 1, confirmations: random(7),
          }));
          model.observe(f.node.now, f.node.tip, outputs);
          f.node.outputs = outputs.map(p => ({ ...payment(links.get(p.order)!.destination, p.sats, p.confirmations), outpoint: p.id }));
          await run(store.observe());
          break;
        }
      }
      assert(model.convertedCount() >= conversions); conversions = model.convertedCount();
      for (const o of step % 10 === 0 ? model.snapshot().orders : selected ? [model.order(selected.id)] : []) {
        const actual = await run(store.order(links.get(o.id)!.token));
        assert.equal(actual.status === "unpaid" ? "quoted" : actual.status, o.state, `state at step ${step}, order ${o.id}`);
        assert.equal(actual.price_sats, o.price, `price at step ${step}, order ${o.id}`);
      }
    }
    assert(links.size > 10, "trace must exercise more than a few successful invoices");
  }));
});
