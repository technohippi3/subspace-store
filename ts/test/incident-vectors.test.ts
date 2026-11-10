// Replays the Python service ledger's incident transitions through the
// incident machine (tools/ledger_vectors.py --family incident), alerts
// included. Equivalence to the Python service: not a model result and not
// regtest evidence.

import assert from "node:assert/strict";
import { test } from "node:test";

import { type Incident, type IncidentEvent, incidentTransition } from "../src/incident.ts";
import { Failures, describeSources, recordVectors } from "./ledger-vectors.ts";

interface PyState { oid: string; incident: Incident | null }
interface Vector {
  kind: "open_incident" | "resolve_incident";
  before: PyState;
  event: { kind?: string; bid?: string | null; resolution?: string | null };
  outcome: { after: PyState | null; refusal: string | null;
             alerts: { oid: string; kind: string; detail: unknown }[] };
}

function toEvent(v: Vector): IncidentEvent {
  if (v.kind === "open_incident") {
    if (v.event.kind === undefined) throw new Error("open without a kind");
    return { type: "open", kind: v.event.kind, bid: v.event.bid ?? null };
  }
  return { type: "resolve", resolution: v.event.resolution ?? null };
}

function same(a: unknown, b: unknown): boolean {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

test("the incident machine makes the Python ledger's incident transitions", () => {
  const rec = recordVectors<Vector>("incident");
  assert.deepEqual(rec.conflicts, []);
  const seen = new Set(rec.vectors.map((v) => `${v.kind}:${v.outcome.refusal ?? "ok"}`));
  assert.deepEqual(["open_incident:ok", "resolve_incident:ok", "resolve_incident:no open incident",
                    "resolve_incident:a resolution must be recorded"].filter((k) => !seen.has(k)),
                   [], "outcomes never recorded");
  const failures = new Failures();
  for (const v of rec.vectors) {
    const got = incidentTransition(v.before, toEvent(v));
    if (got.refusal !== v.outcome.refusal) {
      failures.add(`refusal ${got.refusal}, the ledger's ${v.outcome.refusal}`, v);
    }
    if (!same(got.state, v.outcome.after)) failures.add(`state ${JSON.stringify(got.state)}`, v);
    const alerts = got.effects.map(({ oid, kind, detail }) => ({ oid, kind, detail }));
    if (!same(alerts, v.outcome.alerts)) failures.add(`alerts ${JSON.stringify(alerts)}`, v);
  }
  console.log(describeSources(rec));
  console.log(`incident vectors: ${rec.calls} transitions, ${rec.unique} unique, `
    + `counts ${JSON.stringify(rec.counts)}`);
  assert.equal(failures.count, 0, failures.report());
});
