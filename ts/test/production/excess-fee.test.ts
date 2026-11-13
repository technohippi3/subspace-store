import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { excessFee } from "../../src/bitcoin/excess-fee.ts";
import type { RefundFeeTemplate } from "../../src/refunds/types.ts";

test("Z50: canonical excess measurement adds a bounded fee-input shape without selecting spendable coins", async () => {
  for (const count of [1, 100]) for (const ceiling of [200, 100000]) {
    const calls: RefundFeeTemplate[] = [];
    const inputs = Array.from({ length: count }, (_, n) => ({ outpoint: `${"1".repeat(64)}:${n}`, sats: 1000, script: "0014" + "1".repeat(40) }));
    const result = await Effect.runPromise(excessFee({ inputs, destination: { address: "buyer", script: "0014" + "2".repeat(40) },
      principal: count * 1000, ceiling, rate: 2000 },
      s => Effect.succeed({ address: `template-${s}` }),
      t => Effect.sync(() => {
        calls.push(t); const vbytes = 200 + (t.outputs.length - 1) * 43;
        return { vbytes, fee: vbytes * 2, tip: 10, tipHash: "d".repeat(64) };
      })));
    if (ceiling === 200) {
      assert.equal(calls.length, 2); assert.equal(calls[1]!.outputs.length, 2);
      assert.equal(result.vbytes, 243 + (count === 1 ? 59 : 84));
    } else { assert.equal(calls.length, 1); assert.equal(result.vbytes, 200); }
    assert.equal(calls[0]!.inputs.length, count); assert.equal(result.fee, result.vbytes * 2);
    assert(calls.flatMap(c => c.outputs.slice(1)).every(d => d.script.startsWith("5120")));
  }
});
