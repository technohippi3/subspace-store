import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Change { readonly kind: string; readonly key: string; readonly value: Json }
export interface Entry {
  readonly version: 1; readonly store: string; readonly seq: number;
  readonly previous: string | null; readonly changes: readonly Change[]; readonly hash: string;
}
export function json(value: unknown): asserts value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(json); return; }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    Object.values(value).forEach(json); return;
  }
  throw Error("record must contain only JSON values");
}
export function validateChanges(value: unknown): asserts value is readonly Change[] {
  if (!Array.isArray(value) || value.length === 0) throw Error("empty or invalid journal changes");
  const keys = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== "object" || Object.keys(item).sort().join() !== "key,kind,value")
      throw Error("invalid journal change");
    const change = item as Change;
    if (typeof change.kind !== "string" || !/^[a-z][a-z_]{0,31}$/.test(change.kind) ||
        typeof change.key !== "string" || change.key.length === 0 || change.key.length > 256)
      throw Error("invalid record identity");
    json(change.value);
    const key = JSON.stringify([change.kind, change.key]);
    if (keys.has(key)) throw Error("duplicate record in one transaction");
    keys.add(key);
  }
}
function digest(value: Omit<Entry, "hash">): string {
  return createHash("sha256").update(JSON.stringify([
    value.version, value.store, value.seq, value.previous, value.changes,
  ])).digest("hex");
}
export function entry(store: string, seq: number, previous: string | null,
                      changes: readonly Change[]): Entry {
  validateChanges(changes);
  const stable: unknown = JSON.parse(JSON.stringify(changes));
  validateChanges(stable);
  const body = { version: 1 as const, store, seq, previous, changes: stable };
  return decode(JSON.stringify({ ...body, hash: digest(body) }));
}
export function decode(text: string): Entry {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object") throw Error("invalid journal entry");
  const item = value as Entry;
  if (Object.keys(item).sort().join() !== "changes,hash,previous,seq,store,version" ||
      item.version !== 1 || typeof item.store !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(item.store) || !Number.isSafeInteger(item.seq) || item.seq < 1 ||
      !(item.previous === null || (typeof item.previous === "string" && /^[0-9a-f]{64}$/.test(item.previous))) ||
      typeof item.hash !== "string") throw Error("invalid journal envelope");
  validateChanges(item.changes);
  if (item.hash !== digest(item)) throw Error("journal checksum mismatch");
  return item;
}
