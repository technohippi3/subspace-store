import { Effect } from "effect";
import { ApplicationError, destination, MAX_MONEY, verified } from "../application/records.ts";
import { fee } from "../refunds/policy.ts";
import type { RefundFeeTemplate } from "../refunds/types.ts";
import type { CoreAdapter } from "./core.ts";
import type { BitcoinRpc } from "./rpc.ts";
import { amount, hex, integer, invalid, object } from "./validation.ts";

function point(value: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}:(0|[1-9][0-9]*)$/.test(value)) invalid("invalid estimate input");
  const [txid, index] = value.split(":");
  const vout = integer(Number(index)); if (vout > 0xffff_ffff) invalid("invalid estimate output index");
  return { txid: txid!, vout, sequence: 0xffff_fffd };
}
function psbt(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || !value.startsWith("cHNidP8"))
    invalid("invalid unsigned fee template");
  return value;
}
/** Measures a supplied shape only. Output values are placeholders; their
 * fixed-width serialization has the same size as actual refund amounts.
 * No PSBT, signature or broadcastable transaction leaves this function. */
export function estimateRefundFee(input: RefundFeeTemplate, core: CoreAdapter, node: BitcoinRpc, wallet: BitcoinRpc) {
  const rpc = (client: BitcoinRpc, method: string, ...params: readonly unknown[]) => client.call(method, ...params)
    .pipe(Effect.mapError(e => new ApplicationError({ code: "unavailable", message: e.message })));
  return Effect.gen(function* () {
    const template = yield* verified(() => {
      const r = structuredClone(input);
      if (!r || !Array.isArray(r.inputs) || !r.inputs.length || r.inputs.length > 100 ||
          !Array.isArray(r.outputs) || !r.outputs.length || r.outputs.length > 3) invalid("invalid fee template shape");
      integer(r.rate, 1);
      const ids = new Set<string>(), scripts = new Set<string>(); let total = 0;
      for (const c of r.inputs) {
        point(c.outpoint); destination({ address: "input", script: c.script }); integer(c.sats, 1); total += c.sats;
        if (ids.has(c.outpoint) || total > MAX_MONEY) invalid("duplicate or excessive estimate inputs"); ids.add(c.outpoint);
      }
      for (const o of r.outputs) {
        destination(o); if (scripts.has(o.script)) invalid("duplicate estimate destination"); scripts.add(o.script);
      }
      if (total < r.outputs.length) invalid("fee template outputs exceed inputs");
      return r;
    });
    const start = yield* core.checkReady();
    for (const o of template.outputs) {
      const reply = yield* rpc(node, "validateaddress", o.address);
      yield* verified(() => {
        const v = object(reply);
        if (v.isvalid !== true || v.scriptPubKey !== o.script) invalid("estimate destination differs from Core");
      });
    }
    const created = yield* rpc(node, "createpsbt", template.inputs.map(c => point(c.outpoint)),
      template.outputs.map(o => ({ [o.address]: "0.00000001" })), 0, true);
    const unsigned = yield* verified(() => psbt(created));
    // Explicit false values matter: both RPC defaults would sign/finalize.
    const processed = yield* rpc(wallet, "walletprocesspsbt", unsigned, false, null, true, false);
    const updated = yield* verified(() => {
      const p = object(processed);
      if (p.complete !== false || p.hex !== undefined) invalid("fee template unexpectedly completed");
      return psbt(p.psbt);
    });
    const decoded = yield* rpc(node, "decodepsbt", updated);
    yield* verified(() => {
      const p = object(decoded), tx = object(p.tx);
      if (tx.locktime !== 0 || !Array.isArray(tx.vin) || !Array.isArray(tx.vout) ||
          !Array.isArray(p.inputs) || tx.vin.length !== template.inputs.length ||
          p.inputs.length !== template.inputs.length || tx.vout.length !== template.outputs.length)
        invalid("fee template shape changed");
      for (const [i, c] of template.inputs.entries()) {
        const vin = object(tx.vin[i]), data = object(p.inputs[i]), out = point(c.outpoint);
        if (vin.txid !== out.txid || vin.vout !== out.vout || vin.sequence !== out.sequence ||
            vin.txinwitness !== undefined || (vin.scriptSig !== undefined && object(vin.scriptSig).hex !== "")) invalid("estimate input changed");
        if (Object.keys(data).some(key => key !== "sighash" && /sig|final/.test(key))) invalid("fee template contains signature material");
        if (data.witness_utxo !== undefined) {
          const utxo = object(data.witness_utxo);
          if (amount(utxo.amount) !== c.sats || object(utxo.scriptPubKey).hex !== c.script) invalid("estimate input value or script differs");
        }
        if (data.non_witness_utxo !== undefined) {
          const parent = object(data.non_witness_utxo);
          if (hex(parent.txid) !== out.txid || !Array.isArray(parent.vout)) invalid("missing estimate input data");
          const utxo = object(parent.vout[out.vout]);
          if (utxo.n !== out.vout || amount(utxo.value) !== c.sats || object(utxo.scriptPubKey).hex !== c.script) invalid("estimate input value or script differs");
        }
        if (data.non_witness_utxo === undefined && data.witness_utxo === undefined) invalid("missing estimate input data");
      }
      for (const [i, o] of template.outputs.entries()) {
        const v = object(tx.vout[i]);
        if (v.n !== i || amount(v.value) !== 1 || object(v.scriptPubKey).hex !== o.script) invalid("estimate output changed");
      }
    });
    const analysis = yield* rpc(node, "analyzepsbt", updated);
    const result = yield* verified(() => {
      const a = object(analysis);
      if (a.error !== undefined || !Array.isArray(a.inputs) || a.inputs.length !== template.inputs.length ||
          a.inputs.some(i => object(i).has_utxo !== true || object(i).is_final !== false)) invalid("incomplete unsigned fee estimate");
      const vbytes = integer(a.estimated_vsize, 1);
      if (vbytes > 100_000) invalid("estimated transaction exceeds standard size");
      const networkFee = fee(vbytes, template.rate);
      if (networkFee > MAX_MONEY) invalid("estimated fee exceeds money supply");
      return { vbytes, fee: networkFee, tip: start.height, tipHash: start.hash };
    });
    const end = yield* core.checkReady();
    if (start.hash !== end.hash || start.height !== end.height) return yield* verified(() => invalid("Core changed during fee assessment"));
    return result;
  });
}
