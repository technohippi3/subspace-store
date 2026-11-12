import { canonicalHandle, validP2tr } from "../recipient.ts";
import { fail, type State } from "./records.ts";
import { orderIds } from "./entry.ts";

export interface EntryInput { id: string; root: string; ids: string[] }
export interface BoundEntry {
  version: 1; id: string; root: string;
  bindings: { id: string; handle: string; recipient: string }[];
}
function shape(value: unknown, keys: string): asserts value is { [key: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== keys.split(",").sort().join()) fail("invalid issuance entry fields", "invalid");
}
function identity(id: unknown, root: unknown): void {
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id) ||
      typeof root !== "string" || !/^[0-9a-f]{64}$/.test(root)) fail("invalid issuance entry identity", "invalid");
}
export function entryInput(value: unknown): EntryInput {
  shape(value, "entry,root,oids"); identity(value.entry, value.root);
  return { id: value.entry as string, root: value.root as string, ids: orderIds(value.oids).sort() };
}
export function boundRecord(value: unknown): asserts value is BoundEntry {
  shape(value, "version,id,root,bindings"); identity(value.id, value.root);
  if (value.version !== 1 || !Array.isArray(value.bindings)) fail("invalid issuance entry version");
  for (const b of value.bindings) {
    shape(b, "id,handle,recipient");
    if (!canonicalHandle(b.handle) || !validP2tr(b.recipient)) fail("invalid issuance entry binding");
  }
  const ids = orderIds(value.bindings.map(b => b.id));
  if (ids.join() !== [...ids].sort().join()) fail("noncanonical issuance entry members");
}
export function sameEntry(saved: BoundEntry, input: EntryInput): void {
  if (saved.root !== input.root || saved.bindings.map(b => b.id).join() !== input.ids.join())
    fail("issuance entry identity already binds another root or member set");
}
export function validateEntries(state: State): void {
  const ids = new Set<string>(), orders = new Set<string>();
  for (const e of state.entries) {
    if (ids.has(e.id)) fail("duplicate issuance entry"); ids.add(e.id);
    const spaces = new Set<string>();
    for (const b of e.bindings) {
      const o = state.orders.find(o => o.id === b.id);
      if (!o || o.handle !== b.handle || o.recipient !== b.recipient || o.status !== "issuing" || orders.has(o.id))
        fail("invalid issuance entry relationship");
      orders.add(o.id); spaces.add(o.space);
    }
    if (spaces.size !== 1) fail("issuance entry spans spaces");
  }
}
