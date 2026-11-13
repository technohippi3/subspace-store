import { Effect } from "effect";
import { ApplicationError, destination, verified } from "../application/records.ts";
import { fee, split, excessRefundable } from "../refunds/policy.ts";
import { group, prepared } from "../refunds/records.ts";
import type { BuildRequest, Coin, PreparedRefund, RebuildRequest, RefundOutput, RefundFeeTemplate, ExcessFeeRequest } from "../refunds/types.ts";
import { CoreAdapter, type CoreConfig } from "./core.ts";
import { BitcoinRpc } from "./rpc.ts";
import { amount, hex, integer, invalid, object } from "./validation.ts";
import { replacement } from "../refunds/families.ts";
import { verifyReplacement } from "./exclusivity.ts";
import { rebuildFunding } from "./rebuild-funding.ts";
import { estimateRefundFee } from "./refund-estimate.ts";
import { excessFee } from "./excess-fee.ts";

const decimal = (sats: number) => `${Math.floor(sats / 100_000_000)}.${(sats % 100_000_000).toString().padStart(8, "0")}`;
function outpoint(value: string): { txid: string; vout: number } {
  const match = /^([0-9a-f]{64}):([0-9]+)$/.exec(value);
  if (!match) invalid("invalid refund outpoint");
  const vout = integer(Number(match[2]));
  if (vout > 0xffff_ffff || String(vout) !== match[2]) invalid("invalid refund output index");
  return { txid: match[1]!, vout };
}
/** Explicit inputs only. This component never broadcasts or chooses order credit.
 * Its caller must own the store queue and durably acknowledge the reservation. */
export class CoreRefundWallet {
  private readonly node: BitcoinRpc;
  private readonly wallet: BitcoinRpc;
  private readonly core: CoreAdapter;
  private constructor(config: CoreConfig, core: CoreAdapter) {
    const { wallet, ...node } = config;
    this.node = new BitcoinRpc(node); this.wallet = new BitcoinRpc({ ...node, wallet }); this.core = core;
  }
  static make(config: CoreConfig) {
    return CoreAdapter.make(config).pipe(Effect.flatMap(core => verified(() => new CoreRefundWallet(config, core))));
  }
  private rpc(client: BitcoinRpc, method: string, ...params: readonly unknown[]) {
    return client.call(method, ...params).pipe(Effect.mapError(e => new ApplicationError({ code: "unavailable", message: e.message })));
  }
  resolveAddress(address: string) {
    const self = this;
    return Effect.gen(function* () {
      yield* verified(() => { if (typeof address !== "string" || !address || address.length > 256) invalid("invalid refund address"); });
      yield* self.core.checkReady();
      const reply = yield* self.rpc(self.node, "validateaddress", address);
      return yield* verified(() => {
        const value = object(reply), result = { address, script: value.scriptPubKey };
        if (value.isvalid !== true) invalid("invalid refund address for this network");
        destination(result); return result;
      });
    });
  }
  estimateRate(target: number) {
    const self = this;
    return Effect.gen(function* () {
      yield* verified(() => { integer(target, 2); if (target > 1008) invalid("invalid fee target"); });
      yield* self.core.checkReady();
      const reply = yield* self.rpc(self.node, "estimatesmartfee", target, "CONSERVATIVE");
      return yield* verified(() => {
        const value = object(reply); integer(value.blocks, -1);
        if (value.feerate !== undefined) { const rate = amount(value.feerate); if (!rate) invalid("zero fee estimate"); return rate; }
        if (!Array.isArray(value.errors) || !value.errors.length || value.errors.some(e => typeof e !== "string"))
          invalid("malformed fee estimate");
        return null;
      });
    });
  }
  rebuildFunding(request: RebuildRequest) { return rebuildFunding(request, this.core, this.node, this.wallet); }
  estimateFee(template: RefundFeeTemplate) { return estimateRefundFee(template, this.core, this.node, this.wallet); }
  assessExcess(request: ExcessFeeRequest) {
    return excessFee(request, script => this.rpc(this.node, "decodescript", script), template => this.estimateFee(template));
  }
  private change(forbidden: Set<string>) {
    const self = this;
    return Effect.gen(function* () {
      for (let attempt = 0; attempt <= forbidden.size; attempt++) {
        const address = yield* self.rpc(self.wallet, "getrawchangeaddress", "bech32m");
        const result = yield* self.resolveAddress(address as string);
        const reply = yield* self.rpc(self.wallet, "getaddressinfo", result.address);
        yield* verified(() => { const info = object(reply); if (info.ismine !== true || info.scriptPubKey !== result.script) invalid("refund change is not owned"); });
        if (!forbidden.has(result.script)) { forbidden.add(result.script); return result; }
      }
      return yield* verified(() => invalid("no unused refund change destination"));
    });
  }
  build(input: BuildRequest): Effect.Effect<PreparedRefund, ApplicationError> {
    const self = this;
    return Effect.gen(function* () {
      const request = yield* verified(() => {
        const r = structuredClone(input); group(r.group); destination(r.destination);
        if (r.group.phase !== "reserved") invalid("refund is not reserved");
        const seen = new Set<string>(), scripts = new Set<string>();
        for (const c of r.orderCoins) {
          outpoint(c.outpoint); integer(c.sats, 1); destination({ address: "coin", script: c.script });
          if (seen.has(c.outpoint)) invalid("duplicate order funding claim"); seen.add(c.outpoint); scripts.add(c.script);
        }
        for (const script of r.merchantScripts) {
          destination({ address: "merchant", script }); if (scripts.has(script)) invalid("ambiguous funding ownership");
        }
        if (scripts.has(r.destination.script) || r.merchantScripts.includes(r.destination.script)) invalid("refund destination is funding");
        if (r.replacement) {
          replacement(r.replacement);
          for (const c of r.replacement.requiredInputs) if (r.forbiddenInputs.includes(c.outpoint)) invalid("replacement input belongs to another obligation");
        }
        return r;
      });
      const start = yield* self.core.checkReady(), resolved = yield* self.resolveAddress(request.destination.address);
      if (request.expectedTip && (request.expectedTip.tip !== start.height || request.expectedTip.tipHash !== start.hash))
        return yield* verified(() => invalid("Core tip changed before refund replacement build"));
      if (request.replacement) yield* verifyReplacement(self.node, request.replacement);
      yield* verified(() => { if (resolved.script !== request.destination.script) invalid("refund address changed script"); });
      const unspent = yield* self.rpc(self.wallet, "listunspent", 6, 9_999_999, [], false);
      const coins = yield* verified(() => {
        if (!Array.isArray(unspent)) invalid("invalid unspent output list");
        const result: Coin[] = [], seen = new Set<string>();
        for (const row of unspent) {
          const c = object(row), id = `${hex(c.txid)}:${integer(c.vout)}`;
          if (seen.has(id)) invalid("duplicate unspent output"); seen.add(id); outpoint(id);
          if (c.spendable !== true || c.safe !== true || integer(c.confirmations) < 6 || request.forbiddenInputs.includes(id)) continue;
          const claim = request.orderCoins.find(x => x.outpoint === id);
          const owner = claim ? "order" : request.merchantScripts.includes(c.scriptPubKey as string) ? "merchant" : null;
          if (!owner) continue;
          const sats = amount(c.amount); if (!sats) invalid("empty refund funding");
          destination({ address: "funding", script: c.scriptPubKey });
          if (claim && (claim.script !== c.scriptPubKey || claim.sats !== sats)) invalid("funding claim differs from Core");
          result.push({ outpoint: id, script: c.scriptPubKey as string, sats, owner });
        }
        return result.sort((a, b) => a.outpoint < b.outpoint ? -1 : a.outpoint > b.outpoint ? 1 : 0);
      });
      for (const c of request.replacement?.requiredInputs ?? []) {
        const { txid, vout } = outpoint(c.outpoint), reply = yield* self.rpc(self.node, "gettxout", txid, vout, false);
        yield* verified(() => {
          const v = object(reply);
          if (v.bestblock !== start.hash || integer(v.confirmations) < 6 || amount(v.value) !== c.sats || object(v.scriptPubKey).hex !== c.script)
            invalid("required replacement input is not settled and unspent on-chain");
          const claim = request.orderCoins.find(i => i.outpoint === c.outpoint);
          if (c.owner === "order" ? !claim || claim.script !== c.script || claim.sats !== c.sats : !request.merchantScripts.includes(c.script))
            invalid("required input changed funding owner");
          const existing = coins.find(i => i.outpoint === c.outpoint);
          if (existing) { if (existing.owner !== c.owner || existing.script !== c.script || existing.sats !== c.sats) invalid("replacement funding differs"); }
          else coins.push({ ...c });
        });
      }
      const forbidden = new Set([...request.forbiddenScripts, request.destination.script, ...coins.map(c => c.script)]);
      const ownChange = yield* self.change(forbidden), merchantChange = yield* self.change(forbidden);
      const selected: Coin[] = coins.filter(c => request.replacement?.requiredInputs.some(i => i.outpoint === c.outpoint));
      function select(owner: Coin["owner"], required: number): number {
        let total = selected.filter(c => c.owner === owner).reduce((sum, c) => sum + c.sats, 0);
        for (const c of coins.filter(c => c.owner === owner && !selected.includes(c))) {
          if (total >= required && (total === required || total - required >= 546)) break;
          selected.push(c); total += c.sats;
        }
        if (total < required || (total > required && total - required < 546)) invalid("insufficient settled funding without dust change");
        return total;
      }
      let networkFee = request.replacement?.minimumFee ? request.replacement.minimumFee + 1 : 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const plan = yield* verified(() => {
          const p = split(request.group.charged, Math.max(networkFee, 1), request.group.policy.buyerFeeCeiling,
            request.group.cause === "merchant");
          // The first signed draft measures size; its one-sat fee is never exported.
          if (p.fee > request.group.policy.maximumFee || p.toBuyer < 546) invalid("refund fee or output exceeds policy");
          if (request.group.kind === "excess" && !excessRefundable(request.group.charged, p.fee)) invalid("excess below refund minimum");
          return p;
        });
        const ownTotal = yield* verified(() => select("order", request.group.charged));
        const merchantTotal = yield* verified(() => select("merchant", plan.merchantFee));
        const outputs: RefundOutput[] = [{ ...request.destination, sats: plan.toBuyer, role: "buyer" }];
        if (ownTotal > request.group.charged) outputs.push({ ...ownChange, sats: ownTotal - request.group.charged, role: "order_change" });
        if (merchantTotal > plan.merchantFee) outputs.push({ ...merchantChange, sats: merchantTotal - plan.merchantFee, role: "merchant_change" });
        const raw = yield* self.rpc(self.node, "createrawtransaction", selected.map(c => ({ ...outpoint(c.outpoint), sequence: 0xffff_fffd })),
          outputs.map(o => ({ [o.address]: decimal(o.sats) })), 0, true);
        const reply = yield* self.rpc(self.wallet, "signrawtransactionwithwallet", raw);
        const signed = yield* verified(() => {
          const value = object(reply);
          if (value.complete !== true || typeof value.hex !== "string" || !/^(?:[0-9a-f]{2})+$/.test(value.hex) || value.hex.length > 800_000)
            invalid("refund signing incomplete");
          return value.hex;
        });
        const decoded = yield* self.rpc(self.node, "decoderawtransaction", signed);
        const candidate = yield* verified(() => {
          const d = object(decoded), txid = hex(d.txid), vbytes = integer(d.vsize, 1);
          if (!Array.isArray(d.vin) || !Array.isArray(d.vout) || d.vin.length !== selected.length || d.vout.length !== outputs.length || d.locktime !== 0)
            invalid("signed refund shape differs");
          for (const [index, row] of d.vin.entries()) {
            const c = object(row);
            if (`${hex(c.txid)}:${integer(c.vout)}` !== selected[index]!.outpoint || c.sequence !== 0xffff_fffd) invalid("signed refund inputs differ");
          }
          for (const [index, row] of d.vout.entries()) {
            const o = object(row);
            if (o.n !== index || object(o.scriptPubKey).hex !== outputs[index]!.script || amount(o.value) !== outputs[index]!.sats)
              invalid("signed refund outputs differ");
          }
          const result: PreparedRefund = { txid, raw: signed, vbytes, inputs: structuredClone(selected), outputs,
            fee: plan.fee, buyerFee: plan.buyerFee, merchantFee: plan.merchantFee, toBuyer: plan.toBuyer };
          prepared(result); return result;
        });
        const required = yield* verified(() => fee(candidate.vbytes, request.group.rate));
        if (candidate.fee !== required) { networkFee = required; continue; }
        if (request.replacement && candidate.fee <= request.replacement.minimumFee) return yield* verified(() => invalid("selected replacement fee does not exceed earlier fees"));
        yield* verified(() => group({ ...request.group, phase: "built", transaction: candidate }));
        const acceptance = yield* self.rpc(self.node, "testmempoolaccept", [candidate.raw]);
        yield* verified(() => {
          if (!Array.isArray(acceptance) || acceptance.length !== 1 || object(acceptance[0]).txid !== candidate.txid || object(acceptance[0]).allowed !== true)
            invalid("signed refund is not currently acceptable");
        });
        // Detect spends/reorgs that occurred while constructing and signing.
        for (const c of selected) {
          const required = request.replacement?.requiredInputs.some(i => i.outpoint === c.outpoint);
          const { txid, vout } = outpoint(c.outpoint), reply = yield* self.rpc(self.node, "gettxout", txid, vout, !required);
          yield* verified(() => {
            const value = object(reply);
            if (integer(value.confirmations) < 6 || amount(value.value) !== c.sats || object(value.scriptPubKey).hex !== c.script)
              invalid("refund funding changed while signing");
          });
        }
        const end = yield* self.core.checkReady();
        if (start.hash !== end.hash || start.height !== end.height) return yield* verified(() => invalid("Core changed while preparing refund"));
        return candidate;
      }
      return yield* verified(() => invalid("refund fee did not converge"));
    });
  }
}
