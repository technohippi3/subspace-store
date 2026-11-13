import { Effect } from "effect";
import { ApplicationError, verified } from "../application/records.ts";
import { prepared } from "../refunds/records.ts";
import type { Coin, ExclusiveProof, RebuildRequest } from "../refunds/types.ts";
import type { CoreAdapter } from "./core.ts";
import { BitcoinRpc } from "./rpc.ts";
import { amount, hex, integer, invalid, object } from "./validation.ts";

/** Conservative recovery: conflict outputs are order funds only when every
 * input is already proven to belong to this order. Mixed ownership refuses. */
export function rebuildFunding(input: RebuildRequest, core: CoreAdapter, node: BitcoinRpc, wallet: BitcoinRpc) {
  const rpc = (client: BitcoinRpc, method: string, ...params: unknown[]) => client.call(method, ...params)
    .pipe(Effect.mapError(e => new ApplicationError({ code: "unavailable", message: e.message })));
  return Effect.gen(function* () {
    const request = yield* verified(() => {
      const r = structuredClone(input); r.members.forEach(prepared); hex(r.tipHash); integer(r.tip);
      if (!r.members.length || !r.conflicts.length || new Set(r.members.map(t => t.txid)).size !== r.members.length) invalid("incomplete rebuild request");
      r.conflicts.forEach(hex); return r;
    });
    const start = yield* core.checkReady();
    if (start.hash !== request.tipHash || start.height !== request.tip) return yield* verified(() => invalid("rebuild tip changed"));
    const oldCoins = new Map(request.members.flatMap(t => t.inputs).map(c => [c.outpoint, c]));
    const owned = new Map([...request.orderCoins.map(c => [c.outpoint, c] as const), ...[...oldCoins.values()].filter(c => c.owner === "order").map(c => [c.outpoint, c] as const)]);
    type Candidate = { coin: Coin; via: ExclusiveProof["via"] };
    const candidates: Candidate[] = [];
    for (const c of oldCoins.values()) {
      if (request.forbiddenInputs.includes(c.outpoint)) continue;
      const [id, index] = c.outpoint.split(":"), raw = yield* rpc(node, "gettxout", id, Number(index), true);
      if (raw === null) continue;
      yield* verified(() => {
        const v = object(raw);
        if (v.bestblock !== start.hash || amount(v.value) !== c.sats || object(v.scriptPubKey).hex !== c.script) invalid("old input contents differ");
        if (integer(v.confirmations) >= 6) candidates.push({ coin: { ...c }, via: null });
      });
    }
    let settledConflicts = 0;
    for (const id of request.conflicts) {
      const raw = yield* rpc(wallet, "gettransaction", id, true, true);
      const tx = yield* verified(() => {
        const v = object(raw), d = object(v.decoded);
        if (v.txid !== id || d.txid !== id || !Array.isArray(d.vin) || !Array.isArray(d.vout) || typeof v.hex !== "string" || !/^(?:[0-9a-f]{2})+$/.test(v.hex)) invalid("invalid conflict transaction");
        const inputs = d.vin.map(row => { const i = object(row); return `${hex(i.txid)}:${integer(i.vout)}`; });
        if (new Set(inputs).size !== inputs.length || !inputs.some(i => oldCoins.has(i))) invalid("transaction does not conflict with this refund");
        return { txid: id, raw: v.hex, block: hex(v.blockhash), confirmations: integer(v.confirmations), inputs, outputs: d.vout };
      });
      const header = yield* rpc(node, "getblockheader", tx.block);
      yield* verified(() => {
        const h = object(header);
        if (h.hash !== tx.block || integer(h.confirmations, -1) !== tx.confirmations || integer(h.height) + tx.confirmations - 1 !== start.height || tx.confirmations < 6)
          invalid("rebuild conflict is no longer settled");
      });
      settledConflicts++;
      if (!tx.inputs.every(i => owned.has(i))) continue;
      for (const [index, row] of tx.outputs.entries()) {
        const out = yield* verified(() => {
          const v = object(row), s = object(v.scriptPubKey), sats = amount(v.value);
          if (v.n !== index || typeof s.hex !== "string") invalid("invalid conflict output");
          return { outpoint: `${id}:${index}`, sats, script: s.hex, address: s.address };
        });
        if (out.sats < 546 || request.forbiddenInputs.includes(out.outpoint) || typeof out.address !== "string") continue;
        const addressInfo = yield* rpc(wallet, "getaddressinfo", out.address);
        const info = yield* verified(() => object(addressInfo));
        if (info.ismine !== true) continue;
        yield* verified(() => { if (info.scriptPubKey !== out.script) invalid("conflict output ownership differs"); });
        const unspent = yield* rpc(node, "gettxout", id, index, true);
        if (unspent === null) continue;
        yield* verified(() => {
          const v = object(unspent);
          if (v.bestblock !== start.hash || integer(v.confirmations) < 6 || amount(v.value) !== out.sats || object(v.scriptPubKey).hex !== out.script) invalid("conflict output changed");
        });
        candidates.push({ coin: { outpoint: out.outpoint, sats: out.sats, script: out.script, owner: "order" },
          via: { txid: tx.txid, raw: tx.raw, inputs: tx.inputs } });
      }
    }
    if (!settledConflicts) return yield* verified(() => invalid("no settled conflict evidence"));
    const proofs: ExclusiveProof[] = [], selected = new Map<string, Coin>();
    for (const earlier of request.members) {
      const candidate = candidates.find(c => c.via === null && earlier.inputs.some(i => i.outpoint === c.coin.outpoint)) ??
        candidates.find(c => c.via?.inputs.some(i => earlier.inputs.some(old => old.outpoint === i)));
      if (!candidate) return yield* Effect.fail(new ApplicationError({ code: "refused", message: "no exclusively funded rebuild is available; the obligation stays reserved" }));
      proofs.push({ earlier: earlier.txid, input: candidate.coin.outpoint, via: candidate.via }); selected.set(candidate.coin.outpoint, candidate.coin);
    }
    for (const c of candidates.filter(c => c.via)) selected.set(c.coin.outpoint, c.coin);
    const end = yield* core.checkReady();
    if (end.hash !== start.hash || end.height !== start.height) return yield* verified(() => invalid("Core changed while planning rebuild funding"));
    return { requiredInputs: [...selected.values()], proofs };
  });
}
