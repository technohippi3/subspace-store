/**
 * An order's recovery incident (docs/spec/PAYMENT-SPEC.md, "Host loss and
 * restore"; docs/spec/CONTROLLER-DESIGN.md, "Restore and reconciliation").
 *
 * A port of `open_incident` and `resolve_incident` in `service/ledger.py`.
 * The controller opens an incident on an order when something it can't
 * undo went wrong after delivery: a fulfilled order whose commitment lost
 * finality or was superseded, or one in no live batch after a restore. The
 * order's status doesn't change. An incident gathers the kinds of what went
 * wrong, alerting the owner once per kind, and only the operator closes it,
 * by recording a resolution. Nothing is refunded or reallocated here. A
 * further problem after a resolution opens a new incident.
 *
 * Pure, as `order.ts` and `funds.ts`: it returns the next incident, the
 * alerts to raise and a refusal or null.
 */

export interface Incident {
  /** The batch the incident is about, when the controller knows it. */
  readonly bid: string | null;
  /** In the order they were first reported. */
  readonly kinds: readonly string[];
  readonly resolution: string | null;
}

export interface IncidentState {
  readonly oid: string;
  readonly incident: Incident | null;
}

export type IncidentEvent =
  | { readonly type: "open"; readonly kind: string; readonly bid: string | null }
  | { readonly type: "resolve"; readonly resolution: string | null };

export interface IncidentAlert {
  readonly type: "alert";
  readonly oid: string;
  readonly kind: "incident";
  readonly detail: string;
}

export interface IncidentOutcome {
  readonly state: IncidentState;
  readonly effects: readonly IncidentAlert[];
  readonly refusal: string | null;
}

export function isOpen(incident: Incident | null): incident is Incident {
  return incident !== null && incident.resolution === null;
}

export function incidentTransition(s: IncidentState, e: IncidentEvent): IncidentOutcome {
  switch (e.type) {
    case "open": {
      const current = isOpen(s.incident) ? s.incident
        : { bid: e.bid, kinds: [], resolution: null };
      if (current.kinds.includes(e.kind)) {
        return { state: { ...s, incident: current }, effects: [], refusal: null };
      }
      return {
        state: { ...s, incident: { ...current, kinds: [...current.kinds, e.kind] } },
        effects: [{ type: "alert", oid: s.oid, kind: "incident", detail: e.kind }],
        refusal: null,
      };
    }
    case "resolve":
      if (!isOpen(s.incident)) return { state: s, effects: [], refusal: "no open incident" };
      if (e.resolution === null || e.resolution === "") {
        return { state: s, effects: [], refusal: "a resolution must be recorded" };
      }
      return { state: { ...s, incident: { ...s.incident, resolution: e.resolution } },
               effects: [], refusal: null };
  }
}
