import { Effect } from "effect";
import { advance, alert, monitor, unserved } from "./monitor.ts";
import { claims, fail, sats, whole, type State } from "./records.ts";
import { fee, rate } from "../refunds/policy.ts";
import type { RefundAdapters } from "../refunds/types.ts";
import { checked } from "./records.ts";

export interface ExcessAssessment {
  order: string; principal: number; at: number; tip: number; tipHash: string | null;
  status: "eligible" | "below_minimum" | "unknown"; rate: number | null; vbytes: number | null; fee: number | null;
}
/** Fee failure is not a failed payment observation, nor evidence of a small
 * excess. Preserve clocks and issue one notice per unresolved episode. */
export function assess(state: State, adapters: RefundAdapters | undefined, tipHash: string | undefined, clock: () => number) {
  return Effect.gen(function* () {
    const eligible = new Set<string>();
    for (const order of state.orders) {
      const destination = state.accounts.find(a => a.order === order.id)?.destination;
      const principal = unserved(state, order);
      if (!claims(order) || !destination || principal <= 0) continue;
      const previous = state.assessments.find(a => a.order === order.id);
      const result = yield* Effect.gen(function* () {
        const adapter = yield* checked(() => adapters?.assessExcess ?? fail("missing fee assessment adapter", "unavailable"));
        const selectedRate = yield* adapters!.estimateRate(state.refunds.policy.confirmationTarget).pipe(
          Effect.flatMap(estimate => checked(() => rate(estimate, state.refunds.policy))));
        const r = yield* adapter({ inputs: state.payments.filter(p => p.active && p.confirmations >= 6 && p.script === order.destination!.script)
          .map(p => ({ outpoint: p.outpoint, script: p.script, sats: p.sats })), destination: { ...destination },
          principal, ceiling: state.accounts.find(a => a.order === order.id)!.ceiling!, rate: selectedRate });
        return yield* checked(() => {
          whole(r.vbytes, 1); sats(r.fee);
          if (!tipHash || r.tip !== state.settings.tip || r.tipHash !== tipHash || r.vbytes > 100_000 || r.fee !== fee(r.vbytes, selectedRate))
            fail("inconsistent fee assessment", "unavailable");
          return { rate: selectedRate, vbytes: r.vbytes, fee: r.fee };
        });
      }).pipe(Effect.match({ onSuccess: value => value, onFailure: () => null }));
      yield* checked(() => advance(state, clock()));
      const status = result === null ? "unknown" : principal >= result.fee + 546 ? "eligible" : "below_minimum";
      const value: ExcessAssessment = { order: order.id, principal, at: state.settings.lastTime,
        tip: state.settings.tip, tipHash: tipHash ?? null, status,
        rate: result?.rate ?? null, vbytes: result?.vbytes ?? null, fee: result?.fee ?? null };
      if (status === "unknown" && previous?.status !== "unknown") {
        monitor(state, order.id); alert(state, order.id, "refund_assessment", principal);
      }
      if (previous) Object.assign(previous, value); else state.assessments.push(value);
      if (status === "eligible") eligible.add(order.id);
    }
    return eligible;
  });
}
export function assessment(value: unknown): asserts value is ExcessAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !==
      "at,fee,order,principal,rate,status,tip,tipHash,vbytes") fail("invalid excess assessment");
  const a = value as ExcessAssessment;
  if (typeof a.order !== "string" || !["unknown", "eligible", "below_minimum"].includes(a.status)) fail("invalid assessment status");
  sats(a.principal); whole(a.at); whole(a.tip);
  if (a.tipHash !== null && (typeof a.tipHash !== "string" || !/^[0-9a-f]{64}$/.test(a.tipHash))) fail("invalid assessment tip hash");
  if (a.status === "unknown") {
    if (a.fee !== null || a.rate !== null || a.vbytes !== null) fail("unknown assessment has a fee");
  } else {
    if (a.tipHash === null) fail("assessment has no coherent tip");
    whole(a.rate, 1); whole(a.vbytes, 1); sats(a.fee);
    if (a.vbytes > 100_000 || a.fee !== fee(a.vbytes, a.rate) ||
        (a.principal >= a.fee + 546) !== (a.status === "eligible")) fail("assessment eligibility differs");
  }
}
