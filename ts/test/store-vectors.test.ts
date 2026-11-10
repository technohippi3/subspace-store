// Replays the Python service ledger's store-wide decisions through the
// TypeScript rules (tools/ledger_vectors.py --family store): the request's
// admission, the quote's admission, the exposure figure, the payment
// address chosen from what the wallet gave out, and the recipient
// judgements, the start-up audit's (`recipientProblem`) and the block
// check's (`recipientBlock`). Agreement is equivalence to the Python
// service: not a model result and not regtest evidence.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Destination, type DestinationStep, type StoreAlert, admitQuote, admitRequest,
  considerDestination, exposure, startDestinationSearch,
} from "../src/admission.ts";
import type { OrderStatus } from "../src/order.ts";
import {
  auditRecipients, conflictAlerts, recipientBlock, recipientProblem,
} from "../src/recipient.ts";
import { type StoreView, orderIn } from "../src/view.ts";
import { Failures, describeSources, recordVectors } from "./ledger-vectors.ts";

interface PyOrder {
  oid: string; seq: number; name: string; status: OrderStatus; price: number | null;
  recipient_spk: string; dest_script: string | null; refund_spk: string | null;
  recipient_problem: string | null; seen: number;
}
interface PyView {
  orders: PyOrder[];
  names: Record<string, { name: string; price: number; hold_order: string | null;
                          fulfillment_order: string | null }>;
  refunded_total: number;
}
interface Vector {
  kind: "request" | "quote" | "recipient_problem" | "recipient_block" | "audit_recipients"
    | "alert_conflicts";
  before: PyView & { name?: string; recipient_spk?: string };
  observation: { sales_paused?: boolean; exposure_alerted?: boolean;
                 exposure_limit?: number | null; journal_available?: boolean; exposure?: number;
                 destinations?: string[]; conflict_alerted?: string[] };
  event: { handle?: string; script?: string; oid?: string; draws?: Destination[] };
  outcome: { refusal?: string | null;
             result: string | null;
             reason?: string | null; alerts?: StoreAlert[]; destination?: Destination | null;
             exposure_alerted_after?: boolean;
             flagged?: { oid: string; problem: string }[] };
  source: "directed" | "generated" | null;
}

function toView(v: PyView): StoreView {
  return {
    orders: v.orders.map((o) => ({
      oid: o.oid, seq: o.seq, name: o.name, status: o.status, price: o.price,
      recipientScript: o.recipient_spk, destinationScript: o.dest_script,
      refundScript: o.refund_spk, recipientProblem: o.recipient_problem, seen: o.seen })),
    names: Object.fromEntries(Object.entries(v.names).map(([k, n]) => [k, {
      name: n.name, price: n.price, holdOrder: n.hold_order,
      fulfillmentOrder: n.fulfillment_order }])),
    refundedTotal: v.refunded_total,
  };
}

function same(a: unknown, b: unknown): boolean {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function need<T>(x: T | undefined, what: string): T {
  if (x === undefined) throw new Error(`vector has no ${what}`);
  return x;
}

/** What a quote decided, as the store would reach it: admission, then a
 * destination search fed the addresses the wallet gave out, in order. */
function replayQuote(v: Vector, view: StoreView, fail: (why: string) => void) {
  const obs = v.observation;
  const oid = need(v.event.oid, "oid");
  const got = admitQuote(view, oid, {
    salesPaused: need(obs.sales_paused, "sales_paused"),
    exposureLimit: need(obs.exposure_limit, "exposure_limit"),
    exposureAlerted: need(obs.exposure_alerted, "exposure_alerted"),
    journalAvailable: need(obs.journal_available, "journal_available"),
  });
  const draws = need(v.event.draws, "draws");
  let result = "requote";
  let refusal: string | null = null;
  let alerts: readonly StoreAlert[] = [];
  let alerted = need(obs.exposure_alerted, "exposure_alerted");
  let destination: Destination | null = null;
  let drawn = 0;
  if (got.kind === "refused") {
    result = "refused";
    ({ reason: refusal, alerts } = got);
    alerted = got.exposureAlerted;
  } else if (got.kind === "proceed") {
    let step: DestinationStep = startDestinationSearch(view, oid);
    while (step.kind === "draw") {
      const candidate = draws[drawn++];
      if (candidate === undefined) {
        fail("the search asked for more addresses than the wallet gave out");
        return;
      }
      step = considerDestination(step.search, candidate);
    }
    if (step.kind === "refused") {
      result = "refused";
      refusal = step.reason;
    } else {
      result = "quoted";
      ({ destination, alerts } = step);
      alerted = false;  // a quote made re-arms the limit's alert
    }
  }
  if (result !== v.outcome.result || refusal !== v.outcome.refusal) fail(`${result} ${refusal}`);
  if (drawn !== draws.length) fail(`drew ${drawn} of the wallet's ${draws.length}`);
  if (!same(destination, v.outcome.destination)) fail(`destination ${JSON.stringify(destination)}`);
  if (!same(alerts, v.outcome.alerts)) fail(`alerts ${JSON.stringify(alerts)}`);
  if (alerted !== v.outcome.exposure_alerted_after) fail(`exposure alerted ${alerted}`);
}

test("the store-wide rules make the Python ledger's decisions and judgements", () => {
  const rec = recordVectors<Vector>("store");
  assert.deepEqual(rec.conflicts, []);
  const outcomes = new Set(rec.vectors.map((v) => `${v.kind}:${v.outcome.refusal
    ?? v.outcome.reason ?? v.outcome.result}`));
  const required = ["request:accepted", "request:invalid handle", "request:not for sale",
    "request:script already used",
    "request:script_pubkey must be a 34-byte P2TR script with a valid key",
    "quote:quoted", "quote:requote", "quote:already quoted", "quote:taken for now",
    "quote:recipient not accepted", "quote:script already used", "quote:sales are paused",
    "quote:sales are paused: the store is at its exposure limit",
    "quote:the off-host journal is unavailable; no quote was made",
    "quote:the payment wallet gave out only addresses that orders hold; no quote was made",
    "recipient_problem:null", "recipient_problem:invalid handle",
    "recipient_problem:invalid script", "recipient_problem:store destination script",
    "recipient_block:null", "recipient_block:script conflict", "recipient_block:invalid script"];
  assert.deepEqual(required.filter((k) => !outcomes.has(k)), [], "outcomes never recorded");
  const raised = (kind: string, alert: string) => rec.vectors.some((v) => v.kind === kind
    && (v.outcome.alerts ?? []).some((a) => a.kind === alert));
  assert.ok(raised("audit_recipients", "recipient_invalid"), "no audit that flagged a recipient");
  assert.ok(raised("audit_recipients", "recipient_conflict"), "no audit that alerted a conflict");
  assert.ok(raised("alert_conflicts", "recipient_conflict"), "no conflict alerted while running");
  assert.ok(rec.vectors.some((v) => v.kind === "quote" && v.outcome.result === "quoted"
    && (v.event.draws?.length ?? 0) > 1), "no quote that skipped a held address");

  const failures = new Failures();
  for (const v of rec.vectors) {
    const fail = (why: string) => failures.add(`${v.kind}: ${why}`, v);
    if (v.kind === "recipient_problem") {
      const got = recipientProblem(
        { name: need(v.before.name, "name"), recipientScript: need(v.before.recipient_spk, "script") },
        new Set(need(v.observation.destinations, "destinations")));
      if (got !== v.outcome.result) fail(`judged ${got}`);
      continue;
    }
    const view = toView(v.before);
    if (v.kind === "audit_recipients" || v.kind === "alert_conflicts") {
      const alerted = new Set(need(v.observation.conflict_alerted, "conflict_alerted"));
      const got = v.kind === "audit_recipients" ? auditRecipients(view, alerted)
        : { flagged: [], alerts: conflictAlerts(view, alerted) };
      if (!same(got.flagged, v.outcome.flagged)) fail(`flagged ${JSON.stringify(got.flagged)}`);
      const alerts = got.alerts.map(({ oid, kind, detail }) => ({ oid, kind, detail }));
      if (!same(alerts, v.outcome.alerts)) fail(`alerts ${JSON.stringify(alerts)}`);
      continue;
    }
    if (v.kind === "recipient_block") {
      const o = orderIn(view, need(v.event.oid, "oid"));
      const got = o === undefined ? "no such order" : recipientBlock(view, o);
      if (got !== v.outcome.result) fail(`judged ${got}`);
      continue;
    }
    if (v.kind === "request") {
      const got = admitRequest(view, v.event.handle, v.event.script);
      const reason = got.kind === "accepted" ? null : got.reason;
      if (got.kind !== v.outcome.result || reason !== v.outcome.reason) fail(`${got.kind} ${reason}`);
      continue;
    }
    if (exposure(view) !== v.observation.exposure) {
      fail(`exposure ${exposure(view)}, the ledger's ${v.observation.exposure}`);
    }
    replayQuote(v, view, fail);
  }
  console.log(describeSources(rec));
  console.log(`store vectors: ${rec.calls} calls, ${rec.unique} unique, `
    + `counts ${JSON.stringify(rec.counts)}`);
  assert.equal(failures.count, 0, failures.report());
});
