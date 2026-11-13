import { armInput, type EntryArm } from "./bound-records.ts";
import { fail, whole, type State } from "./records.ts";

export interface CommitmentObservation {
  txid: string; tipHeight: number; tipHash: string;
  minedHeight: number | null; rootHeight: number | null; anchorHeight: number | null;
}
export interface CommitmentRecord { version: 1; entry: string; revision: number; observation: CommitmentObservation }
function fields(value: unknown, names: string): asserts value is { [key: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== names.split(",").sort().join()) fail("invalid commitment fields", "invalid");
}
function hex(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail("invalid commitment hash", "invalid");
}
export function observation(value: unknown): asserts value is CommitmentObservation {
  fields(value, "txid,tipHeight,tipHash,minedHeight,rootHeight,anchorHeight");
  hex(value.txid); hex(value.tipHash); whole(value.tipHeight);
  for (const key of ["minedHeight", "rootHeight", "anchorHeight"]) {
    if (value[key] !== null) { whole(value[key]); if ((value[key] as number) > (value.tipHeight as number)) fail("impossible commitment height"); }
  }
  if (value.rootHeight !== null && value.rootHeight !== value.minedHeight) fail("commitment root/transaction heights differ");
}
export function summary(value: CommitmentObservation) {
  const depth = value.minedHeight === null ? null : value.tipHeight - value.minedHeight;
  const phase = depth === null ? "broadcast" : depth >= 150 && value.rootHeight === value.minedHeight ? "final" : "mined";
  const covered = phase === "final" && value.anchorHeight !== null && value.anchorHeight - value.minedHeight! >= 144;
  return { ...value, phase, depth, covered };
}
export function reportInput(value: unknown) {
  fields(value, "entry,root,oids,delegate,expectedRevision,observation");
  const input = armInput({ entry: value.entry, root: value.root, oids: value.oids, delegate: value.delegate });
  whole(value.expectedRevision); if (value.expectedRevision === Number.MAX_SAFE_INTEGER) fail("commitment revision exhausted");
  observation(value.observation);
  const o = value.observation;
  return { ...input, expectedRevision: value.expectedRevision as number, observation: {
    txid: o.txid, tipHeight: o.tipHeight, tipHash: o.tipHash,
    minedHeight: o.minedHeight, rootHeight: o.rootHeight, anchorHeight: o.anchorHeight } };
}
export function commitmentRecord(value: unknown): asserts value is CommitmentRecord {
  fields(value, "version,entry,revision,observation");
  if (value.version !== 1 || typeof value.entry !== "string" || !/^[0-9a-f]{32}$/.test(value.entry)) fail("invalid commitment record");
  whole(value.revision, 1); observation(value.observation);
}
export function validateCommitments(state: State) {
  const seen = new Set<string>();
  for (const record of state.commitments) {
    if (seen.has(record.entry) || !state.arms.some(a => a.id === record.entry)) fail("commitment has no exclusive armed entry");
    seen.add(record.entry);
  }
}
export function armed(state: State, input: { id: string; root: string; ids: string[]; delegate: string }): EntryArm {
  const arm = state.arms.find(a => a.id === input.id) ?? fail("commitment entry is not armed");
  if (arm.root !== input.root || arm.oids.join() !== input.ids.join() || arm.delegate !== input.delegate) fail("commitment binding differs");
  return arm;
}
