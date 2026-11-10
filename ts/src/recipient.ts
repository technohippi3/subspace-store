/**
 * Recipient requests and claims (docs/spec/PAYMENT-SPEC.md, "Recipient
 * requests"), ported from `service/ledger.py`.
 *
 * A request carries a handle and the buyer's `script_pubkey`. Both must be
 * canonical, never corrected. An unsigned request claims nothing: a script
 * is claimed only by a paid order, from conversion on, and a cancelled
 * order claims nothing. Two paid orders for different handles on one
 * script are a conflict, and neither is issued.
 */

import { FULFILLABLE, ISSUED, type OrderStatus } from "./order.ts";
import type { OrderSummary, StoreView } from "./view.ts";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Anchored on the whole string: `$` without the `m` flag matches only at
// its end, never before a trailing newline.
const HANDLE_RE = new RegExp(`^${LABEL}@${LABEL}$`);
const P2TR_RE = /^5120([0-9a-f]{64})$/;
const SECP256K1_P = 2n ** 256n - 2n ** 32n - 977n;

export function canonicalHandle(handle: unknown): handle is string {
  return typeof handle === "string" && HANDLE_RE.test(handle);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** A 34-byte P2TR script, lowercase hex, whose x-only key is a valid
 * BIP340 public key: the coordinate is below the field size and lifts to a
 * curve point. */
export function validP2tr(script: unknown): script is string {
  if (typeof script !== "string") return false;
  const m = P2TR_RE.exec(script);
  if (m === null || m[1] === undefined) return false;
  const x = BigInt(`0x${m[1]}`);
  if (x >= SECP256K1_P) return false;
  const c = (modPow(x, 3n, SECP256K1_P) + 7n) % SECP256K1_P;
  const y = modPow(c, (SECP256K1_P + 1n) / 4n, SECP256K1_P);
  return (y * y) % SECP256K1_P === c;
}

/** Why a stored order's recipient fails the current rules, or null; the
 * start-up audit's judgement. A database from before a rule can hold an
 * order that breaks it, which a request today would refuse. */
export function recipientProblem(o: Pick<OrderSummary, "name" | "recipientScript">,
                                 destinations: ReadonlySet<string>): string | null {
  if (!canonicalHandle(o.name)) return "invalid handle";
  if (!validP2tr(o.recipientScript)) return "invalid script";
  if (destinations.has(o.recipientScript)) return "store destination script";
  return null;
}

export function destinationScripts(view: StoreView): Set<string> {
  return new Set(view.orders.flatMap((o) => (o.destinationScript === null
    ? [] : [o.destinationScript])));
}

/** A paid order for another handle claims the script. */
export function claimedElsewhere(view: StoreView, handle: string, script: string): boolean {
  return view.orders.some((o) => o.recipientScript === script && o.name !== handle
    && FULFILLABLE.includes(o.status));
}

/** Other paid orders on this order's script for other handles, in creation
 * order. An order already issuing yields only to another issuing one. */
export function conflicting(view: StoreView, o: OrderSummary): string[] {
  const statuses: readonly OrderStatus[] = ISSUED.includes(o.status) ? ISSUED : FULFILLABLE;
  return view.orders.filter((x) => x.recipientScript === o.recipientScript && x.name !== o.name
    && statuses.includes(x.status)).map((x) => x.oid);
}

/** Why this order's recipient may not be issued to, or null. */
export function recipientBlock(view: StoreView, o: OrderSummary): string | null {
  if (o.recipientProblem !== null) return o.recipientProblem;
  if (FULFILLABLE.includes(o.status) && conflicting(view, o).length > 0) return "script conflict";
  return null;
}
