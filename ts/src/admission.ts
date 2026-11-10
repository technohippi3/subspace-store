/**
 * What a request and a quote must pass before an order is created or takes
 * its hold (docs/spec/PAYMENT-SPEC.md, "Recipient requests", "Fixed-price
 * sales" and "Refunds"), ported from `request`, `quote`, `_admit_quote`,
 * `exposure` and `_fresh_destination` in `service/ledger.py`.
 *
 * These rules span orders, so they read a `StoreView`. A request that
 * passes becomes a `requested` order. A quote that passes gets a payment
 * address from a destination search (`startDestinationSearch`, then
 * `considerDestination` for each address the wallet gives out), and then
 * `order.ts` takes the hold.
 * The checks run in the service's order, which decides the message when
 * several fail at once.
 *
 * Asking for a quote again while it holds its name returns the same quote
 * after the recipient checks, and neither the sales pause, the exposure
 * limit nor the journal stops it: nothing new is taken.
 */

import { canonicalHandle, claimedElsewhere, validP2tr } from "./recipient.ts";
import { type OrderSummary, type StoreView, orderIn } from "./view.ts";

export type RequestOutcome =
  /** Malformed: refused before any state is read. */
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "accepted" };

/** A public recipient request: the handle and the buyer's script, and
 * nothing else. The same handle and script again is a retry, accepted as a
 * new order. */
export function admitRequest(view: StoreView, handle: unknown, script: unknown): RequestOutcome {
  if (!canonicalHandle(handle)) return { kind: "invalid", reason: "invalid handle" };
  if (!validP2tr(script)) {
    return { kind: "invalid",
             reason: "script_pubkey must be a 34-byte P2TR script with a valid key" };
  }
  if (view.names[handle] === undefined) return { kind: "refused", reason: "not for sale" };
  // One of the store's payment scripts, or claimed by a paid order for
  // another handle; the refusal names neither.
  if (view.orders.some((o) => o.destinationScript === script)
      || claimedElsewhere(view, handle, script)) {
    return { kind: "refused", reason: "script already used" };
  }
  return { kind: "accepted" };
}

/** Every output seen or mined paying an order's address, less what refunds
 * have charged, plus the unpaid remainder of every quoted order holding its
 * name: a partial payment releases nothing (S2, S4). */
export function exposure(view: StoreView): number {
  let received = 0;
  let outstanding = 0;
  for (const o of view.orders) {
    if (o.destinationScript === null) continue;
    received += o.seen;
    if (o.status === "quoted" && view.names[o.name]?.holdOrder === o.oid) {
      outstanding += Math.max(0, (o.price ?? 0) - o.seen);
    }
  }
  return received - view.refundedTotal + outstanding;
}

export interface QuoteContext {
  readonly salesPaused: boolean;
  /** What new quotes may bring exposure to; null for no limit. */
  readonly exposureLimit: number | null;
  /** The owner was already alerted to the limit since the last quote. */
  readonly exposureAlerted: boolean;
  readonly journalAvailable: boolean;
}

export interface StoreAlert {
  readonly oid: string;
  readonly kind: string;
  readonly detail: unknown;
}

export type QuoteAdmission =
  | { readonly kind: "refused"; readonly reason: string; readonly alerts: readonly StoreAlert[];
      readonly exposureAlerted: boolean }
  /** The order already holds its name: the same quote, nothing taken. */
  | { readonly kind: "requote" }
  /** Take a fresh payment address and the hold. */
  | { readonly kind: "proceed" };

export const SALES_PAUSED = "sales are paused";
export const AT_EXPOSURE_LIMIT = "sales are paused: the store is at its exposure limit";
export const JOURNAL_DOWN = "the off-host journal is unavailable; no quote was made";

function recipientQuotable(view: StoreView, o: OrderSummary): string | null {
  if (o.recipientProblem !== null) return "recipient not accepted";
  if (claimedElsewhere(view, o.name, o.recipientScript)) return "script already used";
  return null;
}

export function admitQuote(view: StoreView, oid: string, ctx: QuoteContext): QuoteAdmission {
  const refused = (reason: string, alerts: readonly StoreAlert[] = [],
                   exposureAlerted = ctx.exposureAlerted): QuoteAdmission =>
    ({ kind: "refused", reason, alerts, exposureAlerted });
  const o = orderIn(view, oid);
  if (o === undefined) return refused("no such order");
  const n = view.names[o.name];
  if (n === undefined) return refused("not for sale");
  if (o.status === "quoted" && n.holdOrder === oid) {
    const why = recipientQuotable(view, o);
    return why === null ? { kind: "requote" } : refused(why);
  }
  if (o.status !== "requested") return refused("already quoted");
  const why = recipientQuotable(view, o);
  if (why !== null) return refused(why);
  if (n.holdOrder !== null || n.fulfillmentOrder !== null) return refused("taken for now");
  if (ctx.salesPaused) return refused(SALES_PAUSED);
  if (ctx.exposureLimit !== null) {
    const current = exposure(view);
    if (current + n.price > ctx.exposureLimit) {
      // The owner is alerted once, until a quote is made again.
      const alerts = ctx.exposureAlerted ? [] : [{
        oid, kind: "exposure_limit",
        detail: { exposure_sats: current, price_sats: n.price, limit_sats: ctx.exposureLimit },
      }];
      return refused(AT_EXPOSURE_LIMIT, alerts, true);
    }
  }
  if (!ctx.journalAvailable) return refused(JOURNAL_DOWN);
  return { kind: "proceed" };
}

export interface Destination {
  readonly address: string;
  readonly script: string;
}

/** A search for a fresh payment address no order holds, for its payment or
 * as its refund address (T3, H11). A wallet restored from a backup can give
 * out again an address a restored quote holds, and a buyer can give a
 * refund address the wallet later gives out. Each address the wallet gives
 * out advances it, so it is asked again, at most once more than the
 * addresses orders hold. A skip alerts the owner, once for the quote. */
export interface DestinationSearch {
  readonly oid: string;
  readonly held: ReadonlySet<string>;
  readonly maxDraws: number;
  readonly drawn: number;
}

/** The search's next step. On `draw` the store asks its payment wallet for
 * a new address, an RPC it makes outside the SQLite write transaction and
 * under its serialized queue, and passes the answer to
 * `considerDestination`. The rules themselves never wait on the wallet. */
export type DestinationStep =
  | { readonly kind: "draw"; readonly search: DestinationSearch }
  | { readonly kind: "chosen"; readonly destination: Destination; readonly skipped: number;
      readonly alerts: readonly StoreAlert[] }
  | { readonly kind: "refused"; readonly reason: string };

export const ONLY_HELD = "the payment wallet gave out only addresses that orders hold; no quote "
  + "was made";

export function startDestinationSearch(view: StoreView, oid: string): DestinationStep {
  const held = new Set<string>();
  let count = 0;
  for (const o of view.orders) {
    for (const s of [o.destinationScript, o.refundScript]) {
      if (s !== null) {
        held.add(s);
        count++;
      }
    }
  }
  return { kind: "draw", search: { oid, held, maxDraws: count + 1, drawn: 0 } };
}

/** One address the wallet gave out: taken if no order holds it, otherwise
 * skipped, and the wallet asked again until the draws run out. */
export function considerDestination(search: DestinationSearch, candidate: Destination):
    DestinationStep {
  const drawn = search.drawn + 1;
  if (!search.held.has(candidate.script)) {
    const skipped = drawn - 1;
    return { kind: "chosen", destination: candidate, skipped,
             alerts: skipped > 0
               ? [{ oid: search.oid, kind: "destination_held", detail: { skipped } }] : [] };
  }
  if (drawn >= search.maxDraws) return { kind: "refused", reason: ONLY_HELD };
  return { kind: "draw", search: { ...search, drawn } };
}
