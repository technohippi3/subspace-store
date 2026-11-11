import { createHash } from "node:crypto";
import { Effect } from "effect";
import { destination, MAX_MONEY, sats, verified, whole, type Destination } from "../application/records.ts";
import { validP2tr } from "../recipient.ts";
import { fee } from "../refunds/policy.ts";
import type { ExcessFeeRequest, FeeAssessment, RefundFeeTemplate } from "../refunds/types.ts";
import { invalid, object } from "./validation.ts";

/** Canonical deadline estimate, independent of the wallet's currently
 * spendable fee coins. Actual signing must still measure the real inputs. */
export function excessFee(input: ExcessFeeRequest,
  decodeScript: (script: string) => Effect.Effect<unknown, import("../application/records.ts").ApplicationError>,
  measure: (template: RefundFeeTemplate) => Effect.Effect<FeeAssessment, import("../application/records.ts").ApplicationError>) {
  return Effect.gen(function* () {
    const r = yield* verified(() => {
      const r = structuredClone(input); sats(r.principal); whole(r.ceiling); whole(r.rate, 1); destination(r.destination);
      if (!Array.isArray(r.inputs) || !r.inputs.length || r.inputs.length > 100) invalid("missing excess measurement inputs");
      const ids = new Set<string>();
      for (const c of r.inputs) {
        sats(c.sats); destination({ address: "input", script: c.script });
        if (typeof c.outpoint !== "string" || ids.has(c.outpoint)) invalid("duplicate excess input"); ids.add(c.outpoint);
      }
      return r;
    });
    const inputs = [...r.inputs].sort((a, b) => a.outpoint < b.outpoint ? -1 : a.outpoint > b.outpoint ? 1 : 0), chosen: typeof inputs = [];
    let sum = 0;
    for (const c of inputs) { if (sum >= r.principal) break; chosen.push(c); sum += c.sats; }
    if (sum < r.principal) return yield* verified(() => invalid("insufficient public receipt metadata"));
    // Public shape placeholders never become actual refund change destinations.
    const changes: Destination[] = [];
    for (let n = 0; changes.length < 2 && n < 128; n++) {
      const script = "5120" + createHash("sha256").update(`subspace-store fee template ${n}`).digest("hex");
      if (!validP2tr(script) || script === r.destination.script) continue;
      const reply = yield* decodeScript(script);
      changes.push(yield* verified(() => { const d = { address: object(reply).address, script }; destination(d); return d; }));
    }
    if (changes.length !== 2) return yield* verified(() => invalid("missing public change template"));
    const outputs = [r.destination, ...(sum > r.principal ? [changes[0]!] : [])];
    const base = yield* measure({ inputs: chosen, outputs, rate: r.rate });
    if (base.fee <= r.ceiling) return base;
    const withChange = yield* measure({ inputs: chosen, outputs: [...outputs, changes[1]!], rate: r.rate });
    if (base.tip !== withChange.tip || base.tipHash !== withChange.tipHash)
      return yield* verified(() => invalid("Core changed during excess fee assessment"));
    // One key-path fee input: <=231 weight units, marker/flag (2) and an
    // empty witness per existing input if the measured template was legacy.
    // <=100 real inputs keeps input-count CompactSize unchanged.
    return yield* verified(() => {
      const vbytes = withChange.vbytes + Math.ceil((233 + chosen.length) / 4), networkFee = fee(vbytes, r.rate);
      if (networkFee > MAX_MONEY || vbytes > 100_000) invalid("excess estimate exceeds bounds");
      return { ...withChange, vbytes, fee: networkFee };
    });
  });
}
