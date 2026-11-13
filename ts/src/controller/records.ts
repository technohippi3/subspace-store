import { refuse } from "./errors.ts";

export const states = ["frozen", "staged", "committed_local", "proved", "checkpointed", "issuing",
  "releasing", "rebuilding", "rebuilt", "broadcast", "broadcast_uncertain", "mined", "final", "fulfilled", "superseded"] as const;
export type BatchState = typeof states[number];
export const sent: readonly BatchState[] = ["broadcast", "broadcast_uncertain", "mined", "final", "fulfilled", "superseded"];
/** Field names and nullable columns preserve the existing controller journal. */
export interface Batch {
  bid: string; space: string; members: string[]; digest: string; state: BatchState;
  prior_root: string | null; root: string | null; delegate_in: string | null; fee_rate: number | null;
  txid: string | null; mined_height: number | null; intent: number; attempted: number;
  supersedes: string | null; answer: string | null; raw: string | null; recovery_paused: number;
  ancestors: string | null; entry_key: string | null; release_failed: string | null;
}
const columns = "bid,space,members,digest,state,prior_root,root,delegate_in,fee_rate,txid,mined_height,intent,attempted,supersedes,answer,raw,recovery_paused,ancestors,entry_key,release_failed".split(",");
export const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export function outpoint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}:(?:0|[1-9][0-9]{0,9})$/.test(value) &&
    Number(value.split(":")[1]) <= 0xffffffff;
}
export function orderIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 10_000 ||
      value.some(id => typeof id !== "string" || !/^o[1-9][0-9]{0,15}$/.test(id)) ||
      new Set(value).size !== value.length || value.join() !== [...value].sort().join()) refuse("invalid controller batch members", "invalid");
}
export function batch(value: unknown): Batch {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid controller batch", "invalid");
  // The three additive migrations also apply to older acknowledged rows.
  const row = { ancestors: null, entry_key: null, release_failed: null, ...value } as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== [...columns].sort().join()) refuse("invalid controller batch fields", "invalid");
  if (typeof row.bid !== "string" || !/^b[1-9][0-9]*$/.test(row.bid) || typeof row.space !== "string" ||
      !/^@[a-z0-9][a-z0-9-]{0,62}$/.test(row.space) || typeof row.digest !== "string" || !row.digest.length ||
      !states.includes(row.state as BatchState)) refuse("invalid controller batch identity", "invalid");
  orderIds(row.members);
  for (const key of ["root", "prior_root", "txid"]) if (row[key] !== null && !hash(row[key])) refuse("invalid controller batch hash", "invalid");
  if (row.entry_key !== null && (typeof row.entry_key !== "string" || !/^[0-9a-f]{32}$/.test(row.entry_key))) refuse("invalid controller entry identity", "invalid");
  if (row.delegate_in !== null && !outpoint(row.delegate_in)) refuse("invalid controller delegate", "invalid");
  if (row.fee_rate !== null && (typeof row.fee_rate !== "number" || !Number.isFinite(row.fee_rate) || row.fee_rate <= 0)) refuse("invalid controller fee rate", "invalid");
  if (row.mined_height !== null && (!Number.isSafeInteger(row.mined_height) || (row.mined_height as number) < 0)) refuse("invalid controller height", "invalid");
  for (const key of ["intent", "attempted", "recovery_paused"]) if (row[key] !== 0 && row[key] !== 1) refuse("invalid controller flag", "invalid");
  for (const key of ["supersedes", "answer", "raw", "ancestors", "release_failed"]) if (row[key] !== null && typeof row[key] !== "string") refuse("invalid controller text", "invalid");
  if (row.supersedes !== null && !/^b[1-9][0-9]*$/.test(row.supersedes as string)) refuse("invalid controller predecessor", "invalid");
  if (row.release_failed !== null) {
    let failed: unknown;
    try { failed = JSON.parse(row.release_failed as string); } catch { return refuse("invalid controller release membership", "invalid"); }
    if (!Array.isArray(failed) || new Set(failed).size !== failed.length || failed.some(id => !(row.members as string[]).includes(id))) refuse("invalid controller release membership", "invalid");
  }
  return structuredClone(row) as unknown as Batch;
}
export function sameIdentity(left: Batch, right: Batch): boolean {
  return ["bid", "space", "digest", "root", "prior_root"].every(key => left[key as keyof Batch] === right[key as keyof Batch]) &&
    left.members.join() === right.members.join();
}
export function sameIntent(left: Batch, right: Batch): boolean {
  return sameIdentity(left, right) && !!left.entry_key && left.entry_key === right.entry_key &&
    left.delegate_in === right.delegate_in && left.fee_rate === right.fee_rate && right.intent === 1;
}
export function entryPayload(b: Batch) {
  if (!b.entry_key || !b.root) refuse("controller entry has no bound identity");
  return { entry: b.entry_key, root: b.root, oids: [...b.members] };
}
