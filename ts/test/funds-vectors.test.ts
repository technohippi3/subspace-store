// Replays the Python service ledger's own refund transitions through the
// funds machine (tools/ledger_vectors.py --family funds): group evaluation,
// reasons, the refund commands, journal acknowledgment and reconciliation.
// The effects are compared too: alerts, authorizations, and which attempts
// were sent. Agreement is equivalence to the Python service: not a model
// result and not regtest evidence.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Attempt, type Funds, type FundsEffect, type FundsEvent, type FundsObservation,
  type FundsOutcome, type FundsPolicy, type Group, type Outpoint, type Reason,
  type RefundDestination, type RefundKind, type RefundTx, evaluateReasons, fundsTransition,
  fundsViolations, stepGroup,
} from "../src/funds.ts";
import type { OrderStatus } from "../src/order.ts";
import { Failures, describeSources, recordVectors } from "./ledger-vectors.ts";

interface PyAttempt {
  txid: string; inputs: [string, number][]; outputs: [string, number][]; raw: string | null;
  to_buyer: number; fee: number; charged: number; exported: number; attempted: number;
  acknowledged: number; journaled: number;
}
interface PyGroup {
  gid: string; kind: RefundKind; closed_by: string | null; needs_rebuild: number;
  paused: number; attempts: PyAttempt[];
}
interface PyFunds {
  order: { oid: string; status: OrderStatus; price_reserve: number; reasons: Reason[];
           losses: Partial<Record<Reason, number>>; dest_script: string | null;
           refund_address: string | null; refund_spk: string | null };
  groups: PyGroup[];
}
interface PyTx { txid: string; inputs: [string, number][]; outputs: [string, number][];
                 raw: string | null }
interface Vector {
  kind: string;
  before: PyFunds;
  observation: FundsObservation;
  event: { gid?: string; gids?: string[]; txid?: string; kind?: string; tx?: PyTx; to_buyer?: number;
           fee?: number; charged?: number | null; exclusive_with?: Record<string, boolean>;
           reason?: string; address?: string; script?: string;
           payment_address_in_use?: boolean };
  outcome: {
    after: PyFunds | null; refusal: string | null;
    alerts: { oid: string; kind: string; detail: unknown }[];
    authorizations: { gid: string; amount: number; available: number }[];
    /** Every transaction handed to the node, exactly as handed. */
    sends: { gid: string | null; tx: PyTx; answer: "sent" | "uncertain" | "failed" }[];
    rebroadcast?: { gid: string; txid: string }[];
  };
  source: "directed" | "generated" | null;
}

function toTx(t: PyTx): RefundTx {
  return { txid: t.txid, raw: t.raw ?? null,
           inputs: t.inputs.map(([x, v]): Outpoint => [x, v]),
           outputs: t.outputs.map(([s, v]) => [s, v] as const) };
}

function toAttempt(a: PyAttempt): Attempt {
  return { tx: toTx(a), toBuyer: a.to_buyer, fee: a.fee, charged: a.charged,
           exported: a.exported !== 0, attempted: a.attempted !== 0,
           acknowledged: a.acknowledged !== 0, journaled: a.journaled !== 0 };
}

function refundTo(address: string | null, script: string | null): RefundDestination | null {
  if ((address === null) !== (script === null)) {
    throw new Error("a refund address without its script, or the reverse");
  }
  return address === null || script === null ? null : { address, script };
}

function toFunds(f: PyFunds): Funds {
  return {
    order: { oid: f.order.oid, status: f.order.status, priceReserve: f.order.price_reserve,
             reasons: f.order.reasons, losses: f.order.losses,
             destinationScript: f.order.dest_script,
             refundTo: refundTo(f.order.refund_address, f.order.refund_spk) },
    groups: f.groups.map((g): Group => {
      const [first, ...rest] = g.attempts;
      if (first === undefined) throw new Error(`group ${g.gid} has no attempt`);
      return { gid: g.gid, kind: g.kind, closedBy: g.closed_by,
               needsRebuild: g.needs_rebuild !== 0, paused: g.paused !== 0,
               attempts: [toAttempt(first), ...rest.map(toAttempt)] };
    }),
  };
}

function need<T>(x: T | undefined, what: string): T {
  if (x === undefined) throw new Error(`vector has no ${what}`);
  return x;
}

/** Runs the machine as the store would for this vector's call. */
function replay(v: Vector, funds: Funds, policy: FundsPolicy): FundsOutcome {
  const e = v.event;
  const obs = v.observation;
  const run = (event: FundsEvent) => fundsTransition(funds, event, obs, policy);
  switch (v.kind) {
    case "step_group": {
      const g = need(funds.groups.find((x) => x.gid === e.gid), "group");
      const next = stepGroup(g, obs);
      return { funds: { ...funds, groups: funds.groups.map((x) => (x.gid === g.gid ? next : x)) },
               effects: [], refusal: null };
    }
    case "reasons": return evaluateReasons(funds, obs);
    case "open_group":
      return run({ type: "openGroup", gid: need(e.gid, "gid"), kind: need(e.kind, "kind"),
                   tx: toTx(need(e.tx, "tx")), toBuyer: need(e.to_buyer, "to_buyer"),
                   fee: need(e.fee, "fee"), charged: e.charged ?? null });
    case "add_attempt":
      return run({ type: "addAttempt", gid: need(e.gid, "gid"), tx: toTx(need(e.tx, "tx")),
                   toBuyer: need(e.to_buyer, "to_buyer"), fee: need(e.fee, "fee"),
                   charged: e.charged ?? null,
                   exclusiveWith: need(e.exclusive_with, "exclusive_with") });
    case "export_psbt": return run({ type: "exportPsbt", txid: need(e.txid, "txid") });
    case "broadcast": {
      const begun = run({ type: "beginBroadcast", gid: need(e.gid, "gid"),
                          txid: need(e.txid, "txid") });
      if (begun.refusal !== null) return begun;
      // The store sends, then records the node's answer.
      const answer = v.outcome.sends.find((s) => s.tx.txid === e.txid);
      const answered = fundsTransition(begun.funds, { type: "broadcastAnswered",
        txid: need(e.txid, "txid"), sent: answer?.answer === "sent" }, obs, policy);
      return { ...answered, effects: [...begun.effects, ...answered.effects] };
    }
    case "rebroadcast": return run({ type: "beginRebroadcast", txid: need(e.txid, "txid") });
    case "reconcile_attempts": return run({ type: "reconcile" });
    case "record_loss": return run({ type: "recordLoss", reason: need(e.reason, "reason") });
    case "set_refund_address":
      return run({ type: "setRefundAddress", address: need(e.address, "address"),
                   script: need(e.script, "script"),
                   paymentAddressInUse: need(e.payment_address_in_use, "payment_address_in_use") });
    case "journaled": return run({ type: "journaled", gids: need(e.gids, "gids") });
    default: throw new Error(`unknown vector kind ${v.kind}`);
  }
}

function same(a: unknown, b: unknown): boolean {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function only<T extends FundsEffect["type"]>(effects: readonly FundsEffect[], type: T) {
  return effects.filter((x): x is Extract<FundsEffect, { type: T }> => x.type === type);
}

test("the funds machine makes the Python ledger's refund transitions", () => {
  const rec = recordVectors<Vector>("funds");
  assert.deepEqual(rec.conflicts, [], "the ledger gave two outcomes for one vector");
  const policy = { excessMinimumOverFee: rec.policy.excess_minimum_over_fee };
  const kinds = new Set(rec.vectors.map((v) => v.kind));
  assert.deepEqual(["step_group", "reasons", "open_group", "add_attempt", "export_psbt",
                    "broadcast", "rebroadcast", "reconcile_attempts", "record_loss",
                    "journaled", "set_refund_address"].filter((k) => !kinds.has(k)), [],
                   "kinds never recorded");
  assert.ok(rec.vectors.some((v) => v.kind === "journaled" && (v.event.gids?.length ?? 0) > 1),
            "no journal entry acknowledging two groups at once");
  assert.ok(rec.vectors.some((v) => v.outcome.sends.length > 0), "no send recorded");
  assert.ok(rec.vectors.some((v) => v.kind === "set_refund_address"
                             && v.event.payment_address_in_use === true
                             && v.event.script !== v.before.order.dest_script),
            "no refund address refused for being another order's payment address");

  const failures = new Failures();
  for (const v of rec.vectors) {
    const fail = (why: string) => failures.add(`${v.kind} ${v.before.order.oid}: ${why}`, v);
    const before = toFunds(v.before);
    for (const bad of fundsViolations(before)) fail(`before: ${bad}`);
    const got = replay(v, before, policy);
    const { after, refusal } = v.outcome;
    if (got.refusal !== refusal) fail(`refusal ${got.refusal}, the ledger's ${refusal}`);
    if (after === null) { fail("no state after"); continue; }
    if (!same(got.funds, toFunds(after))) fail(`funds differ: machine ${JSON.stringify(got.funds)}`);
    for (const bad of fundsViolations(got.funds)) fail(`after: ${bad}`);
    const alerts = only(got.effects, "alert").map(({ oid, kind, detail }) => ({ oid, kind, detail }));
    if (!same(alerts, v.outcome.alerts)) fail(`alerts ${JSON.stringify(alerts)}`);
    const auths = only(got.effects, "authorize")
      .map(({ gid, amount, available }) => ({ gid, amount, available }));
    if (!same(auths, v.outcome.authorizations)) fail(`authorizations ${JSON.stringify(auths)}`);
    // The attempted effects, not only the state: what was sent.
    // What the machine says to send is the stored attempt, in its group.
    for (const s of [...only(got.effects, "send"), ...only(got.effects, "rebroadcast")]) {
      const stored = before.groups.find((g) => g.gid === s.gid)?.attempts
        .find((a) => a.tx.txid === s.tx.txid);
      if (stored === undefined || !same(s.tx, stored.tx)) {
        fail(`${s.type} of ${s.tx.txid} in ${s.gid} isn't that group's stored attempt`);
      }
    }
    // And it is exactly what the Python ledger handed to the node: group,
    // transaction id, inputs, outputs and signed bytes.
    const sends = only(got.effects, "send").map((s) => ({ gid: s.gid, tx: s.tx }));
    const handed = v.outcome.sends.map((s) => ({ gid: s.gid, tx: toTx(s.tx) }));
    if (!same(sends, handed)) fail(`sends ${JSON.stringify(sends)}`);
    const byTxid = (a: { txid: string }, b: { txid: string }) => a.txid.localeCompare(b.txid);
    const again = only(got.effects, "rebroadcast").map((s) => ({ gid: s.gid, txid: s.tx.txid }))
      .sort(byTxid);
    if (!same(again, [...(v.outcome.rebroadcast ?? [])].sort(byTxid))) {
      fail(`rebroadcast ${JSON.stringify(again)}`);
    }
  }
  console.log(describeSources(rec));
  console.log(`funds vectors: ${rec.calls} transitions, ${rec.unique} unique, `
    + `counts ${JSON.stringify(rec.counts)}`);
  assert.equal(failures.count, 0, failures.report());
});
