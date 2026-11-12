import { armInput } from "./bound-records.ts";
import { alert, monitor } from "./monitor.ts";
import { fail, whole, type State } from "./records.ts";

export interface Fulfillment {
  version: 1; oid: string; entry: string; revision: number; certificateHash: string; proofHash: string;
  relayRoot: string; relayHeight: number; batchHeight: number; anchorHeight: number; tipHeight: number; tipHash: string;
}
export const recoveryReasons = ["certificate_checkpoint_lost", "commitment_lost"] as const;
export interface RecoveryIncident {
  version: 1; id: number; oid: string; entry: string; revision: number;
  reasons: (typeof recoveryReasons[number])[]; resolution: string | null;
}
function fields(v: unknown, names: string): asserts v is { [key: string]: unknown } {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== names.split(",").sort().join()) fail("invalid delivery fields", "invalid");
}
function hash(v: unknown) { if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) fail("invalid delivery hash", "invalid"); }
function order(v: unknown) { if (typeof v !== "string" || !/^o[1-9][0-9]{0,15}$/.test(v)) fail("invalid delivery order", "invalid"); }
function entry(v: unknown) { if (typeof v !== "string" || !/^[0-9a-f]{32}$/.test(v)) fail("invalid delivery entry", "invalid"); }
export function statusInput(value: unknown) {
  fields(value, "entry,root,oids,delegate,oid");
  const input = armInput({ entry: value.entry, root: value.root, oids: value.oids, delegate: value.delegate });
  order(value.oid); if (!input.ids.includes(value.oid as string)) fail("delivery order is not a member");
  return { ...input, oid: value.oid as string };
}
export function deliveryInput(value: unknown) {
  fields(value, "entry,root,oids,delegate,oid,revision,certificateHash,relayRoot,relayHeight,proofHash");
  const input = statusInput({ entry: value.entry, root: value.root, oids: value.oids, delegate: value.delegate, oid: value.oid });
  whole(value.revision, 1); whole(value.relayHeight); hash(value.certificateHash); hash(value.relayRoot); hash(value.proofHash);
  return { ...input, revision: value.revision as number, certificateHash: value.certificateHash as string,
    relayRoot: value.relayRoot as string, relayHeight: value.relayHeight as number, proofHash: value.proofHash as string };
}
export function resolutionInput(value: unknown) {
  fields(value, "incident,resolution"); whole(value.incident, 1);
  if (typeof value.resolution !== "string" || !value.resolution.trim() || value.resolution.length > 2000) fail("invalid incident resolution", "invalid");
  return { incident: value.incident as number, resolution: value.resolution };
}
export function openRecovery(state: State, oid: string, reason: typeof recoveryReasons[number]) {
  const order = state.orders.find(o => o.id === oid)!;
  if (order.status !== "fulfilled") return;
  const fulfillment = state.fulfillments.find(f => f.oid === oid)!;
  let incident = state.incidents.find(i => i.oid === oid && i.resolution === null);
  if (!incident) {
    incident = { version: 1, id: Math.max(0, ...state.incidents.map(i => i.id)) + 1, oid, entry: fulfillment.entry,
      revision: state.commitments.find(c => c.entry === fulfillment.entry)!.revision, reasons: [], resolution: null };
    state.incidents.push(incident);
  }
  if (!incident.reasons.includes(reason)) { incident.reasons.push(reason); monitor(state, oid); alert(state, oid, "recovery_incident", 0); }
}
export function fulfillmentRecord(v: unknown): asserts v is Fulfillment {
  fields(v, "version,oid,entry,revision,certificateHash,proofHash,relayRoot,relayHeight,batchHeight,anchorHeight,tipHeight,tipHash");
  if (v.version !== 1) fail("invalid fulfillment version"); order(v.oid); entry(v.entry); whole(v.revision, 1);
  for (const k of ["certificateHash", "proofHash", "relayRoot", "tipHash"]) hash(v[k]);
  for (const k of ["relayHeight", "batchHeight", "anchorHeight", "tipHeight"]) whole(v[k]);
  const f = v as unknown as Fulfillment;
  if (f.relayHeight < f.batchHeight || f.tipHeight - f.relayHeight < 150 || f.anchorHeight - f.relayHeight < 144 || f.anchorHeight > f.tipHeight)
    fail("invalid historical fulfillment bounds");
}
export function incidentRecord(v: unknown): asserts v is RecoveryIncident {
  fields(v, "version,id,oid,entry,revision,reasons,resolution");
  if (v.version !== 1) fail("invalid recovery incident version"); whole(v.id, 1); order(v.oid); entry(v.entry); whole(v.revision, 1);
  if (!Array.isArray(v.reasons) || !v.reasons.length || new Set(v.reasons).size !== v.reasons.length ||
      v.reasons.some(r => !recoveryReasons.includes(r)) || (v.resolution !== null &&
      (typeof v.resolution !== "string" || !v.resolution.trim() || v.resolution.length > 2000))) fail("invalid recovery incident");
}
export function validateDeliveries(state: State) {
  const seen = new Set<string>();
  for (const f of state.fulfillments) {
    const e = state.entries.find(e => e.id === f.entry), c = state.commitments.find(c => c.entry === f.entry);
    if (seen.has(f.oid) || !e?.bindings.some(b => b.id === f.oid) || !c || f.revision > c.revision ||
        !state.certificates.some(c => c.entry === f.entry && c.oid === f.oid) || state.orders.find(o => o.id === f.oid)?.status !== "fulfilled" ||
        (f.relayRoot === e.root ? f.relayHeight !== f.batchHeight : f.relayHeight <= f.batchHeight)) fail("invalid fulfillment relationship");
    if (!state.certificates.find(c => c.oid === f.oid)!.valid && !state.incidents.some(i => i.oid === f.oid))
      fail("invalid fulfilled recovery incident relationship");
    seen.add(f.oid);
  }
  if (state.orders.some(o => o.status === "fulfilled" && !seen.has(o.id))) fail("fulfilled order has no verified delivery");
  const open = new Set<string>();
  for (const [index, i] of state.incidents.entries()) {
    const f = state.fulfillments.find(f => f.oid === i.oid);
    if (i.id !== index + 1 || !f || i.entry !== f.entry || i.revision > state.commitments.find(c => c.entry === i.entry)!.revision ||
        (i.resolution === null && open.has(i.oid))) fail("invalid recovery incident relationship");
    if (i.resolution === null) open.add(i.oid);
  }
}
