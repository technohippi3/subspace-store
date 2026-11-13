import { canonicalHandle } from "../recipient.ts";
import { refuse } from "./errors.ts";
import type { ControllerEvent, ControllerJournal } from "./journal.ts";
import { hash, orderIds, type Batch } from "./records.ts";

export const preparationOperations = ["pending_set", "sync", "park", "unpark", "pending_clear"] as const;
export type PreparationOperation = typeof preparationOperations[number];
interface Binding { version: 1; bid: string; space: string; members: string[]; digest: string }
export interface PendingRecord extends Binding { phase: "owned" | "cleared" }
export interface EffectRecord extends Binding {
  operation: PreparationOperation; labels: string[]; phase: "intent" | "confirmed"; acknowledged: boolean | null;
}
function binding(value: Record<string, unknown>): void {
  if (value.version !== 1 || typeof value.bid !== "string" || !/^b[1-9][0-9]*$/.test(value.bid) || typeof value.space !== "string" ||
      !canonicalHandle("probe" + value.space) || !hash(value.digest)) refuse("invalid preparation history binding", "invalid");
  orderIds(value.members);
  if ((value.members as string[]).length > 1000) refuse("preparation history membership exceeds API bound", "invalid");
}
export function preparationRecord(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid preparation history", "invalid");
  const row = value as Record<string, unknown>, pending = row.kind === "preparation_pending";
  const fields = "bid,digest,kind,members,phase,seq,space,version" + (pending ? "" : ",operation,labels,acknowledged");
  if (!pending && row.kind !== "preparation_effect" || Object.keys(row).sort().join() !== fields.split(",").sort().join() ||
      !Number.isSafeInteger(row.seq) || (row.seq as number) < 1) refuse("invalid preparation history fields", "invalid");
  binding(row);
  if (pending) {
    if (row.phase !== "owned" && row.phase !== "cleared") refuse("invalid preparation ownership phase", "invalid");
  } else {
    if (!preparationOperations.includes(row.operation as PreparationOperation) || !["intent", "confirmed"].includes(String(row.phase)) ||
        !Array.isArray(row.labels) || row.labels.length > 10_000 || new Set(row.labels).size !== row.labels.length ||
        row.labels.some(label => typeof label !== "string" || !canonicalHandle(label + row.space)) ||
        row.labels.join() !== [...row.labels].sort().join() || (!["park", "unpark"].includes(String(row.operation)) && row.labels.length) ||
        (row.phase === "confirmed" && ["pending_set", "pending_clear"].includes(String(row.operation)) ?
          typeof row.acknowledged !== "boolean" : row.acknowledged !== null)) refuse("invalid preparation effect history", "invalid");
  }
}
function same(left: Binding, right: Binding): boolean {
  return left.bid === right.bid && left.space === right.space && left.digest === right.digest && left.members.join() === right.members.join();
}
function identity(b: Batch): Binding { return { version: 1, bid: b.bid, space: b.space, members: [...b.members], digest: b.digest }; }
export function preparationHistory(entries: readonly ControllerEvent[]) {
  let owner: PendingRecord | null = null, unresolved: EffectRecord | null = null, last: EffectRecord | null = null;
  const latest = new Map<string, PendingRecord>();
  for (const event of entries) {
    if (event.kind !== "preparation_pending" && event.kind !== "preparation_effect") continue;
    preparationRecord(event);
    if (event.kind === "preparation_pending") {
      const row = event as unknown as PendingRecord;
      if (row.phase === "owned") {
        if (owner && !same(owner, row)) refuse("overlapping global preparation owners", "invalid");
        if (!owner) last = null;
        owner = row;
      } else {
        if (!owner || !same(owner, row) || unresolved || last?.operation !== "pending_clear" || last.phase !== "confirmed" || !last.acknowledged)
          refuse("preparation owner cleared without acknowledged completion", "invalid");
        owner = null;
      }
      latest.set(row.bid, row);
    } else {
      const row = event as unknown as EffectRecord;
      if (!owner || !same(owner, row)) refuse("preparation effect has no exact global owner", "invalid");
      if (row.phase === "intent") {
        if (unresolved) refuse("overlapping preparation effects", "invalid"); unresolved = row;
      } else {
        if (!unresolved || !same(unresolved, row) || row.operation !== unresolved.operation || row.labels.join() !== unresolved.labels.join())
          refuse("preparation completion has no exact intent", "invalid");
        unresolved = null;
      }
      last = row;
    }
  }
  return { owner, unresolved, latest };
}
export function requirePreparationIdle(journal: ControllerJournal, preparingBid?: string): void {
  const state = preparationHistory(journal.entries());
  if (state.unresolved || state.owner && state.owner.bid !== preparingBid)
    refuse("preparation effect or global pending owner requires reconciliation", "restore_required");
}
export class PreparationBarrier {
  private readonly journal: ControllerJournal;
  constructor(journal: ControllerJournal) { this.journal = journal; }
  state() { return preparationHistory(this.journal.entries()); }
  acquire(b: Batch): void {
    const state = this.state();
    if (state.unresolved || state.owner && !same(state.owner, identity(b))) refuse("global preparation owner requires reconciliation", "restore_required");
    if (!state.owner) this.journal.appendEvent("preparation_pending", { ...identity(b), phase: "owned" });
  }
  intent(b: Batch, operation: PreparationOperation, labels: readonly string[]): void {
    const state = this.state();
    if (!state.owner || !same(state.owner, identity(b)) || state.unresolved) refuse("preparation effect requires reconciliation", "restore_required");
    this.journal.appendEvent("preparation_effect", { ...identity(b), operation, labels: [...labels].sort(), phase: "intent", acknowledged: null });
  }
  confirm(b: Batch, operation: PreparationOperation, labels: readonly string[], acknowledged: boolean | null): void {
    this.confirmIntent(b, operation, labels);
    this.journal.appendEvent("preparation_effect", { ...identity(b), operation, labels: [...labels].sort(), phase: "confirmed", acknowledged });
    this.state();
  }
  confirmIntent(b: Batch, operation: PreparationOperation, labels: readonly string[]): void {
    const state = this.state(), expected = [...labels].sort();
    if (!state.owner || !same(state.owner, identity(b)) || !state.unresolved || !same(state.unresolved, identity(b)) ||
        state.unresolved.operation !== operation || state.unresolved.labels.join() !== expected.join())
      refuse("exact live preparation intent unavailable; reconciliation required", "restore_required");
  }
  finish(b: Batch): void { this.journal.appendEvent("preparation_pending", { ...identity(b), phase: "cleared" }); this.state(); }
}
