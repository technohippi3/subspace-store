import { Effect } from "effect";
import { ApplicationError, verified } from "../application/records.ts";
import type { SupersessionCheck } from "../application/supersession-records.ts";
import { CoreAdapter, type CoreConfig } from "./core.ts";
import { BitcoinRpc } from "./rpc.ts";
import { hex, integer, object } from "./validation.ts";

/** Independent Core proof of the exact settled delegate conflict and checkpoint.
 * Spaces root exclusion is a trusted controller attestation, not verified here. */
export function conflictVerifier(config: CoreConfig) {
  return Effect.gen(function* () {
    const core = yield* CoreAdapter.make(config), { wallet: _wallet, ...nodeConfig } = config, node = new BitcoinRpc(nodeConfig);
    return (check: SupersessionCheck) => Effect.gen(function* () {
      const p = check.proof;
      if (!(yield* core.containsBlock({ tipHash: check.tipHash, height: p.tipHeight, hash: p.tipHash }))) return false;
      const rpc = (method: string, ...params: unknown[]) => node.call(method, ...params).pipe(Effect.mapError(e => new ApplicationError({ code: "unavailable", message: e.message })));
      const original = yield* rpc("decoderawtransaction", p.originalRaw);
      const header = yield* rpc("getblockheader", p.blockHash), tx = yield* rpc("getrawtransaction", p.conflictTxid, true, p.blockHash);
      const matches = yield* verified(() => {
        const h = object(header), t = object(tx);
        const old = object(original);
        const spends = (v: { [k: string]: unknown }) => {
          if (!Array.isArray(v.vin)) throw Error("invalid conflict inputs");
          return v.vin.map(object).some(i => `${hex(i.txid)}:${integer(i.vout)}` === check.delegate);
        };
        if (hex(old.txid) !== p.txid || !spends(old) || !Array.isArray(old.vout) || !old.vout.map(object).some(o => {
          const script = object(o.scriptPubKey).hex;
          return typeof script === "string" && script.startsWith("6a") && script.includes(check.root);
        })) throw Error("original transaction does not bind this delegate/root");
        if (hex(h.hash) !== p.blockHash || integer(h.height) !== p.height) throw Error("conflict block identity differs");
        if (integer(h.confirmations, -1) < 6) return false;
        if (hex(t.txid) !== p.conflictTxid || t.blockhash !== p.blockHash || !Array.isArray(t.vin)) throw Error("conflict transaction identity differs");
        return spends(t);
      });
      // Bracket the read against the same current tip. An RPC error is unknown,
      // never proof of reversal, absence or permission to release anything.
      const tip = yield* rpc("getblockchaininfo");
      yield* verified(() => {
        const info = object(tip), h = object(header);
        if (info.bestblockhash !== check.tipHash || (matches && integer(h.height) + integer(h.confirmations) - 1 !== integer(info.blocks)))
          throw Error("Core changed during supersession check");
      });
      return matches;
    });
  });
}
