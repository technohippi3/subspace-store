/**
 * An order's funds and refund obligations (docs/spec/PAYMENT-SPEC.md,
 * "Ledger", "Authorization, obligations and exposure" and "Refunds").
 *
 * A port of the refund side of `service/ledger.py`: the derived balances
 * (`available`, `reserved`, `deficits`), the evaluation of refund groups
 * (`_step_group`) and of the order's `reconciling` reasons (`_reasons`),
 * and the refund commands. Like `order.ts` it is pure. A transition takes
 * one order's funds, one event and what the store observed, and returns
 * the next funds, the effects the store must carry out, and a refusal or
 * null. It sends nothing: a broadcast is a `send` effect, and its answer
 * comes back as the event `broadcastAnswered`.
 *
 * Balances are never stored. They come from the observation: the chain
 * position of the order's payment outputs, of each attempt, and of each
 * spend of an attempt's inputs. A lookup the observation doesn't hold
 * throws, so a store that observed too little fails loudly.
 *
 * What it doesn't decide: that a group or attempt id is unused across the
 * whole store (the store's unique keys), which order an attempt id belongs
 * to, whether two transactions are mutually exclusive (the store reads the
 * chain and passes the answer with `addAttempt`), what the off-host journal
 * acknowledged (passed as `journaled`), and the order's status, which only
 * `order.ts` changes.
 */

import { BATCHABLE, ISSUED, type OrderStatus, SETTLED } from "./order.ts";

export const REASONS = ["issuance", "post_issuance_deficit", "refunds"] as const;
export type Reason = (typeof REASONS)[number];

/** Statuses whose settled funds are refundable in full. */
export const REFUNDABLE_IN_FULL: readonly OrderStatus[] = ["cancelled", "refund_due"];

export type Outpoint = readonly [txid: string, vout: number];

export interface RefundTx {
  readonly txid: string;
  readonly inputs: readonly Outpoint[];
  readonly outputs: readonly (readonly [script: string, value: number])[];
  /** The signed transaction, once built; null in a model or for a PSBT. */
  readonly raw: string | null;
}

export interface Attempt {
  readonly tx: RefundTx;
  readonly toBuyer: number;
  readonly fee: number;
  /** What the attempt charges the order: `toBuyer + fee` unless the store
   * bears part of it. */
  readonly charged: number;
  readonly exported: boolean;
  /** A broadcast was attempted, answered or not. */
  readonly attempted: boolean;
  /** The node accepted it, or it was later seen on chain or in a mempool. */
  readonly acknowledged: boolean;
  /** In an acknowledged off-host journal entry. Nothing leaves the store
   * for an attempt until it is. */
  readonly journaled: boolean;
}

export type RefundKind = "excess" | "cancellation";

/** An obligation group: one refund the store owes, and every attempt to pay
 * it. Its reservation is its largest attempt's charge while it is open; a
 * settled attempt closes it, and losing that depth reopens it. */
export interface Group {
  readonly gid: string;
  readonly kind: RefundKind;
  readonly attempts: readonly [Attempt, ...Attempt[]];
  readonly closedBy: string | null;
  /** A spend outside the group settled against one of its inputs. */
  readonly needsRebuild: boolean;
  /** An attempt that wasn't exclusive with every other was refused. */
  readonly paused: boolean;
}

/** Where the buyer's refunds go, given through the order link. */
export interface RefundDestination {
  readonly address: string;
  readonly script: string;
}

export interface FundsOrder {
  readonly oid: string;
  readonly status: OrderStatus;
  /** The order's own payment script, from its quote; read only. */
  readonly destinationScript: string | null;
  readonly refundTo: RefundDestination | null;
  readonly priceReserve: number;
  /** Sorted. */
  readonly reasons: readonly Reason[];
  /** The deficit the operator recorded as a loss, by reason. */
  readonly losses: Readonly<Partial<Record<Reason, number>>>;
}

export interface Funds {
  readonly order: FundsOrder;
  /** In the order they were opened. */
  readonly groups: readonly Group[];
}

export interface TxFacts {
  /** Conventional confirmations on the best chain; 0 if unmined. */
  readonly conf: number;
  /** On the best chain or in the node's mempool. */
  readonly known: boolean;
}

export interface FundsObservation {
  /** Every output paying the order, mined or in the mempool. */
  readonly payments: readonly { readonly value: number; readonly conf: number }[];
  /** Every attempt, and every transaction spending an attempt's input. */
  readonly txs: Readonly<Record<string, TxFacts>>;
  /** The mined spend of each attempt input, by "txid:vout". */
  readonly spenders: Readonly<Record<string, string | null>>;
}

export interface FundsPolicy {
  /** An excess is refunded only if it is at least its fee plus this. */
  readonly excessMinimumOverFee: number;
}

export type FundsEvent =
  /** Evaluate every group, then the reasons, as `observe` does. */
  | { readonly type: "evaluate" }
  | { readonly type: "openGroup"; readonly gid: string; readonly kind: string;
      readonly tx: RefundTx; readonly toBuyer: number; readonly fee: number;
      readonly charged: number | null }
  /** A fee bump in the family, or a replacement family. `exclusiveWith`
   * says, for each attempt already in the group, whether it and the new
   * one can never both be mined. */
  | { readonly type: "addAttempt"; readonly gid: string; readonly tx: RefundTx;
      readonly toBuyer: number; readonly fee: number; readonly charged: number | null;
      readonly exclusiveWith: Readonly<Record<string, boolean>> }
  | { readonly type: "exportPsbt"; readonly txid: string }
  /** Record the attempt as broadcast; the store then sends it. */
  | { readonly type: "beginBroadcast"; readonly gid: string; readonly txid: string }
  /** The node's answer: `sent` only if it surely reached the network. */
  | { readonly type: "broadcastAnswered"; readonly txid: string; readonly sent: boolean }
  /** The same signed transaction again; its answer changes nothing. */
  | { readonly type: "beginRebroadcast"; readonly txid: string }
  /** After a restart, before anything else: look every attempt up. */
  | { readonly type: "reconcile" }
  | { readonly type: "recordLoss"; readonly reason: string }
  /** The buyer's refund destination. The store has already turned the
   * address into its script for the node's network, or refused it, and
   * says whether any order holds that script as its payment address. */
  | { readonly type: "setRefundAddress"; readonly address: string; readonly script: string;
      readonly paymentAddressInUse: boolean }
  /** A journal entry holding these groups, with every attempt in them, was
   * acknowledged off-host. One entry can hold several. */
  | { readonly type: "journaled"; readonly gids: readonly string[] };

export type FundsEffect =
  | { readonly type: "authorize"; readonly gid: string; readonly amount: number;
      readonly available: number }
  | { readonly type: "alert"; readonly oid: string; readonly kind: string;
      readonly detail: unknown }
  /** Transmit exactly this transaction, the attempt's as stored, now. */
  | { readonly type: "send"; readonly gid: string; readonly tx: RefundTx }
  /** `reconcile` found an attempted broadcast nowhere: send it again. */
  | { readonly type: "rebroadcast"; readonly gid: string; readonly tx: RefundTx };

/** A refusal can keep a change: an attempt refused for not being exclusive
 * still pauses its group. */
export interface FundsOutcome {
  readonly funds: Funds;
  readonly effects: readonly FundsEffect[];
  readonly refusal: string | null;
}

export class FundsError extends Error {
  override name = "FundsError";
}

// Lookups

function txFacts(obs: FundsObservation, txid: string): TxFacts {
  const f = obs.txs[txid];
  if (f === undefined) throw new FundsError(`the observation has no facts for ${txid}`);
  return f;
}

function spenderOf(obs: FundsObservation, [txid, vout]: Outpoint): string | null {
  const s = obs.spenders[`${txid}:${vout}`];
  if (s === undefined) throw new FundsError(`the observation has no spender for ${txid}:${vout}`);
  return s;
}

function attemptIn(g: Group, txid: string): Attempt {
  const a = g.attempts.find((x) => x.tx.txid === txid);
  if (a === undefined) throw new FundsError(`${g.gid} has no attempt ${txid}`);
  return a;
}

function findAttempt(funds: Funds, txid: string): { group: Group; attempt: Attempt } | null {
  for (const group of funds.groups) {
    const attempt = group.attempts.find((a) => a.tx.txid === txid);
    if (attempt !== undefined) return { group, attempt };
  }
  return null;
}

// Balances, derived from chain position

export function sumAt(obs: FundsObservation, depth: number): number {
  return obs.payments.reduce((s, p) => s + (p.conf >= depth ? p.value : 0), 0);
}

export function reservation(g: Group): number {
  return Math.max(...g.attempts.map((a) => a.charged));
}

export function refundedTotal(funds: Funds): number {
  return funds.groups.reduce(
    (s, g) => s + (g.closedBy === null ? 0 : attemptIn(g, g.closedBy).charged), 0);
}

export function reserved(funds: Funds): number {
  return funds.groups.reduce((s, g) => s + (g.closedBy === null ? reservation(g) : 0), 0);
}

export function available(funds: Funds, obs: FundsObservation): number {
  return sumAt(obs, SETTLED) - refundedTotal(funds) - reserved(funds) - funds.order.priceReserve;
}

export function deficits(funds: Funds, obs: FundsObservation): Record<Reason, number> {
  const { status, priceReserve: reserve } = funds.order;
  const batchable = sumAt(obs, BATCHABLE);
  const settled = sumAt(obs, SETTLED);
  const shortfall = reserve > 0 ? reserve - batchable : 0;
  return {
    issuance: status === "converted" ? shortfall : 0,
    post_issuance_deficit: ISSUED.includes(status) ? shortfall : 0,
    refunds: refundedTotal(funds) + reserved(funds) - Math.max(0, settled - reserve),
  };
}

/** A transaction outside the group spends one of its inputs and has settled. */
export function conflictSettled(g: Group, obs: FundsObservation): boolean {
  const ids = new Set(g.attempts.map((a) => a.tx.txid));
  return g.attempts.some((a) => a.tx.inputs.some((op) => {
    const sp = spenderOf(obs, op);
    return sp !== null && !ids.has(sp) && txFacts(obs, sp).conf >= SETTLED;
  }));
}

// Evaluation

function replaceGroup(funds: Funds, g: Group): Funds {
  return { ...funds, groups: funds.groups.map((x) => (x.gid === g.gid ? g : x)) };
}

/** Close a group by its first settled attempt, reopen it when that attempt
 * loses settled depth, and mark it for rebuilding once a conflicting spend
 * settles. */
export function stepGroup(g: Group, obs: FundsObservation): Group {
  const settled = g.attempts.filter((a) => txFacts(obs, a.tx.txid).conf >= SETTLED)
    .map((a) => a.tx.txid);
  let next = g;
  if (g.closedBy === null && settled.length > 0) {
    next = { ...next, closedBy: settled[0] ?? null };
  } else if (g.closedBy !== null && txFacts(obs, g.closedBy).conf < SETTLED) {
    next = { ...next, closedBy: settled[0] ?? null };
  }
  if (!g.needsRebuild && conflictSettled(g, obs)) next = { ...next, needsRebuild: true };
  return next;
}

/** A deficit above what is recorded as a loss makes its reason
 * `reconciling`, alerting the owner as it appears; one at or below it
 * clears. */
export function evaluateReasons(funds: Funds, obs: FundsObservation): FundsOutcome {
  const o = funds.order;
  const reasons = new Set<Reason>(o.reasons);
  const effects: FundsEffect[] = [];
  const d = deficits(funds, obs);
  for (const reason of REASONS) {
    const over = d[reason] - (o.losses[reason] ?? 0);
    if (over > 0) {
      if (!reasons.has(reason)) effects.push({ type: "alert", oid: o.oid, kind: reason, detail: over });
      reasons.add(reason);
    } else {
      reasons.delete(reason);
    }
  }
  const sorted = [...reasons].sort();
  const same = sorted.length === o.reasons.length && sorted.every((r, i) => r === o.reasons[i]);
  return { funds: same ? funds : { ...funds, order: { ...o, reasons: sorted } }, effects,
           refusal: null };
}

function evaluate(funds: Funds, obs: FundsObservation): FundsOutcome {
  const stepped = funds.groups.reduce((f, g) => replaceGroup(f, stepGroup(g, obs)), funds);
  return evaluateReasons(stepped, obs);
}

// Commands

const ok = (funds: Funds, effects: readonly FundsEffect[] = []): FundsOutcome =>
  ({ funds, effects, refusal: null });
const refuse = (funds: Funds, refusal: string, effects: readonly FundsEffect[] = []):
  FundsOutcome => ({ funds, effects, refusal });

function newAttempt(tx: RefundTx, toBuyer: number, fee: number, charged: number): Attempt {
  return { tx, toBuyer, fee, charged, exported: false, attempted: false, acknowledged: false,
           journaled: false };
}

function mapAttempts(g: Group, f: (a: Attempt) => Attempt): Group {
  const [first, ...rest] = g.attempts;
  return { ...g, attempts: [f(first), ...rest.map(f)] };
}

function updateAttempt(funds: Funds, txid: string, change: Partial<Attempt>): Funds {
  return {
    ...funds,
    groups: funds.groups.map((g) => mapAttempts(
      g, (a) => (a.tx.txid === txid ? { ...a, ...change } : a))),
  };
}

/** The attempt, once its group's entry is acknowledged off-host; the
 * precondition for anything that leaves the store. */
function journaledAttempt(funds: Funds, txid: string):
    { group: Group; attempt: Attempt } | string {
  const found = findAttempt(funds, txid);
  if (found === null) return "no such attempt";
  if (!found.attempt.journaled) return "journal entry not acknowledged off-host";
  return found;
}

function outpointKey([txid, vout]: Outpoint): string {
  return `${txid}:${vout}`;
}

function openGroup(funds: Funds, e: Extract<FundsEvent, { type: "openGroup" }>,
                   obs: FundsObservation, policy: FundsPolicy): FundsOutcome {
  if (funds.groups.some((g) => g.gid === e.gid)) return refuse(funds, "group exists");
  if (e.kind !== "excess" && e.kind !== "cancellation") {
    return refuse(funds, "unknown refund kind");
  }
  if (e.kind === "cancellation" && !REFUNDABLE_IN_FULL.includes(funds.order.status)) {
    return refuse(funds, "order is not cancelled or refund due");
  }
  if (funds.order.reasons.includes("refunds")) return refuse(funds, "refunds are reconciling");
  const charged = e.charged ?? e.toBuyer + e.fee;
  const avail = available(funds, obs);
  if (e.kind === "excess" && avail < e.fee + policy.excessMinimumOverFee) {
    return refuse(funds, "excess below the refund minimum");
  }
  if (charged > avail) return refuse(funds, "not enough settled funds");
  const group: Group = { gid: e.gid, kind: e.kind, closedBy: null, needsRebuild: false,
                         paused: false, attempts: [newAttempt(e.tx, e.toBuyer, e.fee, charged)] };
  return ok({ ...funds, groups: [...funds.groups, group] },
            [{ type: "authorize", gid: e.gid, amount: charged, available: avail }]);
}

function addAttempt(funds: Funds, e: Extract<FundsEvent, { type: "addAttempt" }>,
                    obs: FundsObservation): FundsOutcome {
  const g = funds.groups.find((x) => x.gid === e.gid);
  if (g === undefined) return refuse(funds, "no such refund");
  if (g.closedBy !== null) return refuse(funds, "group closed");
  const charged = e.charged ?? e.toBuyer + e.fee;
  const inputs = new Set(e.tx.inputs.map(outpointKey));
  const inFamily = g.attempts[0].tx.inputs.every((op) => inputs.has(outpointKey(op)));
  if (!inFamily && !conflictSettled(g, obs)) {
    return refuse(funds, "a replacement family needs a settled conflicting spend");
  }
  const exclusive = g.attempts.every((a) => {
    const x = e.exclusiveWith[a.tx.txid];
    if (x === undefined) throw new FundsError(`no exclusivity answer for ${a.tx.txid}`);
    return x;
  });
  if (!exclusive) {
    // The pause is recorded and kept, then the attempt is refused.
    const effects: FundsEffect[] = g.paused ? []
      : [{ type: "alert", oid: funds.order.oid, kind: "refund_paused", detail: g.gid }];
    return refuse(replaceGroup(funds, { ...g, paused: true }),
                  "not mutually exclusive with every attempt; paused", effects);
  }
  const increase = Math.max(0, charged - reservation(g));
  const avail = available(funds, obs);
  if (increase > avail) return refuse(funds, "not enough settled funds for the increase");
  const next: Group = { ...g, paused: false,
                        attempts: [...g.attempts, newAttempt(e.tx, e.toBuyer, e.fee, charged)] };
  return ok(replaceGroup(funds, next),
            [{ type: "authorize", gid: g.gid, amount: increase, available: avail }]);
}

function recordLoss(funds: Funds, reason: string, obs: FundsObservation): FundsOutcome {
  const r = REASONS.find((x) => x === reason);
  if (r === undefined) return refuse(funds, "unknown reason");
  const value = deficits(funds, obs)[r];
  if (value <= 0) return refuse(funds, "no deficit to record");
  const o = funds.order;
  return ok({ ...funds, order: { ...o, losses: { ...o.losses, [r]: value },
                                 reasons: o.reasons.filter((x) => x !== r) } });
}

function reconcile(funds: Funds, obs: FundsObservation): FundsOutcome {
  let next = funds;
  const effects: FundsEffect[] = [];
  for (const g of funds.groups) {
    for (const a of g.attempts) {
      if (txFacts(obs, a.tx.txid).known) {
        if (!a.acknowledged) next = updateAttempt(next, a.tx.txid, { acknowledged: true });
      } else if (a.attempted) {
        effects.push({ type: "rebroadcast", gid: g.gid, tx: a.tx });
      }
    }
  }
  return ok(next, effects);
}

/** One transition of one order's funds. */
export function fundsTransition(funds: Funds, event: FundsEvent, obs: FundsObservation,
                                policy: FundsPolicy): FundsOutcome {
  switch (event.type) {
    case "evaluate":
      return evaluate(funds, obs);
    case "openGroup":
      return openGroup(funds, event, obs, policy);
    case "addAttempt":
      return addAttempt(funds, event, obs);
    case "exportPsbt": {
      const found = journaledAttempt(funds, event.txid);
      if (typeof found === "string") return refuse(funds, found);
      return ok(updateAttempt(funds, event.txid, { exported: true }));
    }
    case "beginBroadcast": {
      const found = journaledAttempt(funds, event.txid);
      if (typeof found === "string") return refuse(funds, found);
      if (found.group.gid !== event.gid) return refuse(funds, "attempt is not in this group");
      return ok(updateAttempt(funds, event.txid, { attempted: true }),
                [{ type: "send", gid: event.gid, tx: found.attempt.tx }]);
    }
    case "broadcastAnswered": {
      if (findAttempt(funds, event.txid) === null) return refuse(funds, "no such attempt");
      return ok(event.sent ? updateAttempt(funds, event.txid, { acknowledged: true }) : funds);
    }
    case "beginRebroadcast": {
      const found = journaledAttempt(funds, event.txid);
      if (typeof found === "string") return refuse(funds, found);
      return ok(updateAttempt(funds, event.txid, { attempted: true }),
                [{ type: "send", gid: found.group.gid, tx: found.attempt.tx }]);
    }
    case "reconcile":
      return reconcile(funds, obs);
    case "recordLoss":
      return recordLoss(funds, event.reason, obs);
    case "setRefundAddress": {
      const o = funds.order;
      // Never a payment address of any order, this one's included: a refund
      // paying it would count as that order's payment.
      if (event.paymentAddressInUse || event.script === o.destinationScript) {
        return refuse(funds, "a refund never goes to one of the store's payment addresses");
      }
      // Once a refund is built, its destination is fixed.
      if (funds.groups.length > 0) {
        return refuse(funds, "a refund has been built; its destination is fixed");
      }
      return ok({ ...funds, order: { ...o, refundTo: { address: event.address,
                                                         script: event.script } } });
    }
    case "journaled": {
      if (!event.gids.every((gid) => funds.groups.some((g) => g.gid === gid))) {
        return refuse(funds, "no such refund");
      }
      return ok({ ...funds, groups: funds.groups.map((g) => (event.gids.includes(g.gid)
        ? mapAttempts(g, (a) => ({ ...a, journaled: true })) : g)) });
    }
  }
}

/** What holds for every order's funds, as a list of what fails. */
export function fundsViolations(funds: Funds): string[] {
  const out: string[] = [];
  const gids = new Set<string>();
  for (const g of funds.groups) {
    if (gids.has(g.gid)) out.push(`group ${g.gid} twice`);
    gids.add(g.gid);
    if (g.closedBy !== null && !g.attempts.some((a) => a.tx.txid === g.closedBy)) {
      out.push(`${g.gid} closed by ${g.closedBy}, which isn't one of its attempts`);
    }
    for (const a of g.attempts) {
      if ((a.attempted || a.exported) && !a.journaled) {
        out.push(`${a.tx.txid} left the store before it was journaled`);
      }
    }
  }
  const sorted = [...funds.order.reasons].sort();
  if (sorted.some((r, i) => r !== funds.order.reasons[i])) out.push("reasons not sorted");
  // `setRefundAddress` refuses a payment address, and destination selection
  // skips refund addresses (PAYMENT-SPEC.md, "Refunds", T1 to T3).
  if (refundsToOwnAddress(funds)) out.push("refunds go to the order's own address");
  return out;
}

/** The order's refund destination is its own payment script. */
export function refundsToOwnAddress(funds: Funds): boolean {
  const to = funds.order.refundTo;
  return to !== null && to.script === funds.order.destinationScript;
}
