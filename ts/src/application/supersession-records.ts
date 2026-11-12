import { armInput } from "./bound-records.ts";
import { fail, whole, type State } from "./records.ts";
import { invalidateCertificate } from "./certificate-records.ts";
import { openRecovery } from "./delivery-records.ts";

export interface Supersession {
  version: 1; entry: string; revision: number; txid: string; originalRaw: string; conflictTxid: string;
  blockHash: string; height: number; tipHeight: number; tipHash: string; active: boolean;
}
export interface SupersessionCheck { entry: string; root: string; delegate: string; proof: Supersession; tipHash: string }
function fields(v: unknown, names: string): asserts v is { [k: string]: unknown } {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== names.split(",").sort().join()) fail("invalid supersession fields", "invalid");
}
function hash(v: unknown) { if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) fail("invalid supersession hash", "invalid"); }
export function supersessionInput(v: unknown) {
  fields(v, "entry,root,oids,delegate,revision,txid,originalRaw,conflictTxid,blockHash,height,tipHeight,tipHash,rootAbsent,confirm");
  const binding = armInput({ entry: v.entry, root: v.root, oids: v.oids, delegate: v.delegate });
  if (v.confirm !== binding.id || v.rootAbsent !== true) fail("supersession requires explicit confirmation and root exclusion", "invalid");
  const proof: Supersession = { version: 1, entry: binding.id, revision: v.revision as number, txid: v.txid as string, originalRaw: v.originalRaw as string,
    conflictTxid: v.conflictTxid as string, blockHash: v.blockHash as string, height: v.height as number,
    tipHeight: v.tipHeight as number, tipHash: v.tipHash as string, active: true };
  supersessionRecord(proof); return { ...binding, proof };
}
export function supersessionRecord(v: unknown): asserts v is Supersession {
  fields(v, "version,entry,revision,txid,originalRaw,conflictTxid,blockHash,height,tipHeight,tipHash,active");
  if (v.version !== 1 || typeof v.entry !== "string" || !/^[0-9a-f]{32}$/.test(v.entry) || typeof v.active !== "boolean") fail("invalid supersession record");
  whole(v.revision, 1); whole(v.height); whole(v.tipHeight);
  for (const k of ["txid", "conflictTxid", "blockHash", "tipHash"]) hash(v[k]);
  if (typeof v.originalRaw !== "string" || !/^(?:[0-9a-f]{2})+$/.test(v.originalRaw) || v.originalRaw.length > 800_000) fail("invalid superseded transaction bytes");
  if (v.txid === v.conflictTxid || (v.tipHeight as number) - (v.height as number) + 1 < 6) fail("supersession is not a settled conflict");
}
export function liveEntries(state: State, oid: string) {
  return state.entries.filter(e => e.bindings.some(b => b.id === oid) && !state.closures.some(c => c.id === e.id) &&
    !state.supersessions.some(s => s.entry === e.id && s.active));
}
export function liveHandleEntries(state: State, handle: string) {
  return state.entries.filter(e => e.bindings.some(b => b.handle === handle) && !state.closures.some(c => c.id === e.id) &&
    !state.supersessions.some(s => s.entry === e.id && s.active));
}
export function usableEntry(state: State, id: string) {
  const e = state.entries.find(e => e.id === id);
  return !!e && !state.closures.some(c => c.id === id) && !state.supersessions.some(s => s.entry === id && s.active) &&
    e.bindings.every(b => liveEntries(state, b.id).length === 1 && liveHandleEntries(state, b.handle).length === 1);
}
export function revokeSupersession(state: State, proof: Supersession) {
  proof.active = false;
  const e = state.entries.find(e => e.id === proof.entry)!;
  for (const b of e.bindings) {
    const o = state.orders.find(o => o.id === b.id)!;
    if (o.status === "converted" && liveEntries(state, o.id).length === 1) o.status = "issuing";
    else openRecovery(state, o.id, "supersession_reversed", e.id);
  }
}
export function applySupersession(state: State, proof: Supersession) {
  state.supersessions.push(proof);
  const e = state.entries.find(e => e.id === proof.entry)!;
  for (const b of e.bindings) {
    const cert = state.certificates.find(c => c.oid === b.id && c.entry === e.id);
    if (cert) invalidateCertificate(state, cert, "superseded");
    const order = state.orders.find(o => o.id === b.id)!;
    if (order.status === "fulfilled") openRecovery(state, order.id, "superseded", e.id);
    else if (["issuing", "ready"].includes(order.status)) order.status = "converted";
  }
  state.pending = state.pending.filter(oid => !e.bindings.some(b => b.id === oid));
}
export function validateSupersessions(state: State) {
  const seen = new Set<string>();
  for (const s of state.supersessions) {
    const arm = state.arms.find(a => a.id === s.entry), report = state.commitments.find(c => c.entry === s.entry);
    const key = `${s.entry}:${s.revision}`;
    if (seen.has(key) || !arm || !report || report.observation.txid !== s.txid || s.revision > report.revision ||
        (s.active && state.supersessions.some(later => later.entry === s.entry && later.revision > s.revision))) fail("invalid supersession relationship");
    seen.add(key);
    if (s.active && (report.observation.minedHeight !== null || state.certificates.some(c => c.entry === s.entry && c.valid))) fail("active supersession retains a live commitment");
  }
  for (const o of state.orders) if (liveEntries(state, o.id).length > 1 && !state.incidents.some(i => i.oid === o.id && i.reasons.includes("supersession_reversed")))
    fail("overlapping issuance entries lack a recovery incident");
}
