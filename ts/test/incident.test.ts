// The incident machine on its own. Tests of the TypeScript port, not model
// results and not regtest evidence.

import assert from "node:assert/strict";
import { test } from "node:test";

import { type IncidentState, incidentTransition } from "../src/incident.ts";

const NONE: IncidentState = { oid: "o1", incident: null };

test("an incident gathers kinds, alerting once per kind, until resolved", () => {
  const first = incidentTransition(NONE, { type: "open", kind: "finality_lost", bid: "b1" });
  assert.deepEqual(first.state.incident, { bid: "b1", kinds: ["finality_lost"], resolution: null });
  assert.deepEqual(first.effects, [{ type: "alert", oid: "o1", kind: "incident",
                                     detail: "finality_lost" }]);
  const again = incidentTransition(first.state, { type: "open", kind: "finality_lost", bid: "b9" });
  assert.deepEqual(again.state, first.state);
  assert.deepEqual(again.effects, []);
  const second = incidentTransition(first.state, { type: "open", kind: "superseded", bid: "b2" });
  assert.deepEqual(second.state.incident?.kinds, ["finality_lost", "superseded"]);
  assert.equal(second.state.incident?.bid, "b1");
});

test("only a recorded resolution closes it; a later problem opens a new one", () => {
  assert.equal(incidentTransition(NONE, { type: "resolve", resolution: "x" }).refusal,
               "no open incident");
  const open = incidentTransition(NONE, { type: "open", kind: "superseded", bid: "b1" }).state;
  for (const resolution of ["", null]) {
    const r = incidentTransition(open, { type: "resolve", resolution });
    assert.equal(r.refusal, "a resolution must be recorded");
    assert.deepEqual(r.state, open);
  }
  const closed = incidentTransition(open, { type: "resolve", resolution: "reissued" }).state;
  assert.equal(closed.incident?.resolution, "reissued");
  assert.equal(incidentTransition(closed, { type: "resolve", resolution: "again" }).refusal,
               "no open incident");
  const reopened = incidentTransition(closed, { type: "open", kind: "superseded", bid: null });
  assert.deepEqual(reopened.state.incident, { bid: null, kinds: ["superseded"], resolution: null });
  assert.equal(reopened.effects.length, 1);
});
