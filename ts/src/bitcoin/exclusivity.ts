import { Effect } from "effect";
import { ApplicationError, verified } from "../application/records.ts";
import { replacement as validate } from "../refunds/families.ts";
import type { Replacement } from "../refunds/types.ts";
import { BitcoinRpc } from "./rpc.ts";
import { hex, integer, invalid, object } from "./validation.ts";

/** Decode every saved ancestor, binding structural exclusivity to actual txids. */
export function verifyReplacement(node: BitcoinRpc, replacement: Replacement) {
  return Effect.gen(function* () {
    yield* verified(() => validate(replacement));
    const checked = new Map<string, string[]>();
    const transactions = [ ...replacement.members.map(t => ({ txid: t.txid, raw: t.raw, inputs: t.inputs.map(c => c.outpoint) })),
      ...replacement.proofs.flatMap(p => p.via ? [p.via] : []) ];
    for (const tx of transactions) {
      if (checked.has(tx.txid)) {
        yield* verified(() => { if (JSON.stringify(checked.get(tx.txid)) !== JSON.stringify(tx.inputs)) invalid("ancestor input evidence differs"); });
        continue;
      }
      const reply = yield* node.call("decoderawtransaction", tx.raw).pipe(Effect.mapError(e => new ApplicationError({ code: "unavailable", message: e.message })));
      const inputs = yield* verified(() => {
        const d = object(reply);
        if (d.txid !== tx.txid || !Array.isArray(d.vin)) invalid("replacement ancestor identity differs");
        const inputs = d.vin.map(row => { const v = object(row); return `${hex(v.txid)}:${integer(v.vout)}`; });
        if (JSON.stringify(inputs) !== JSON.stringify(tx.inputs)) invalid("replacement ancestor inputs differ");
        return inputs;
      });
      checked.set(tx.txid, inputs);
    }
  });
}
