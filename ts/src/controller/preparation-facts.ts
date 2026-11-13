import { canonicalHandle, validP2tr } from "../recipient.ts";
import { refuse } from "./errors.ts";
import { hash, type Batch } from "./records.ts";

export function object(value: unknown, required: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.split(",").some(key => !Object.hasOwn(value, key)))
    refuse("invalid preparation response", "invalid");
  return value as Record<string, unknown>;
}
export const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100_000;
export interface StagedHandle { name: string; script_pubkey: string; commitment_root: string | null; parked: boolean }
export function handleFact(value: unknown, space: string): StagedHandle {
  const row = object(value, "name,script_pubkey,status,commitment_root,commitment_idx,publish_status,parked");
  if (Object.hasOwn(row, "dev_private_key") || typeof row.name !== "string" || !canonicalHandle(row.name + space) || !validP2tr(row.script_pubkey) ||
      typeof row.parked !== "boolean" || row.commitment_root !== null && !hash(row.commitment_root) ||
      (row.commitment_root === null ? row.commitment_idx !== null || row.status !== "staged" : !count(row.commitment_idx) || row.status !== "committed") ||
      row.publish_status !== null && typeof row.publish_status !== "string") refuse("invalid native preparation handle", "invalid");
  return { name: row.name as string, script_pubkey: row.script_pubkey, commitment_root: row.commitment_root as string | null, parked: row.parked };
}
export function pageFact(value: unknown, space: string, page: number, filter: "staged" | "committed") {
  const row = object(value, "handles,total,page,per_page,total_pages");
  if (Object.keys(row).sort().join() !== "handles,page,per_page,total,total_pages" || !Array.isArray(row.handles) || row.handles.length > 100 ||
      !count(row.total) || row.total > 10_000 || row.page !== page || row.per_page !== 100 || row.total_pages !== Math.ceil(row.total / 100))
    refuse("invalid native preparation page", "invalid");
  const handles = row.handles.map(value => handleFact(value, space));
  if (handles.some(handle => (handle.commitment_root === null) !== (filter === "staged")) || handles.length !== Math.min(100, Math.max(0, row.total - (page - 1) * 100)))
    refuse("native preparation page is incomplete or mismatched", "invalid");
  return { handles, total: row.total, pages: row.total_pages as number };
}
export function pipelineFact(value: unknown) {
  const row = object(value, "has_pending,staged_count,commitment_idx,root,txid,steps"), steps = object(row.steps, "local,proving,broadcast,confirmed,finalized,published");
  if (typeof row.has_pending !== "boolean" || !count(row.staged_count) || row.root !== null && !hash(row.root) || row.txid !== null && !hash(row.txid) ||
      (row.root === null ? row.txid !== null || row.commitment_idx !== null || row.has_pending || steps.local !== "pending" : !count(row.commitment_idx) || steps.local !== "complete") ||
      Object.values(steps).some(value => !["complete", "in_progress", "pending", "skipped"].includes(String(value))))
    refuse("invalid native preparation pipeline", "invalid");
  return { root: row.root as string | null, txid: row.txid as string | null, pending: row.has_pending, staged: row.staged_count };
}
export function syncFact(value: unknown): void {
  const row = object(value, "success,pulled,staged,errors");
  if (typeof row.success !== "boolean" || !count(row.pulled) || !count(row.staged) || !Array.isArray(row.errors) ||
      row.errors.length > 1000 || row.errors.some(value => typeof value !== "string") || row.success !== (row.errors.length === 0))
    refuse("invalid registry sync response", "invalid");
  // Aggregate counts/success can span other spaces. Exact target readback decides.
}
export function commitFact(value: unknown, b: Batch): string {
  const row = object(value, "space,prev_root,root,handles_committed,is_initial");
  if (Object.keys(row).sort().join() !== "handles_committed,is_initial,prev_root,root,space" || row.space !== b.space || row.prev_root !== b.prior_root ||
      !hash(row.root) || row.handles_committed !== b.members.length || row.is_initial !== (b.prior_root === null))
    refuse("invalid or mismatched local commitment response; reconciliation required", "restore_required");
  return row.root;
}
