import { canonicalHandle, validP2tr } from "../recipient.ts";
import { fail, postIssuance, type State } from "./records.ts";
import { orderIds } from "./entry.ts";

export interface EntryInput { id: string; root: string; ids: string[] }
export interface BoundEntry {
  version: 1; id: string; root: string;
  bindings: { id: string; handle: string; recipient: string }[];
}
export interface EntryClosure { version: 1; id: string; root: string; oids: string[] }
export interface EntryArm extends EntryClosure { delegate: string }
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
function delegate(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}:(?:0|[1-9][0-9]{0,9})$/.test(value) ||
      Number(value.split(":")[1]) > 0xffffffff) fail("invalid delegate outpoint", "invalid");
}
export function armInput(value: unknown): EntryInput & { delegate: string } {
  shape(value, "entry,root,oids,delegate"); delegate(value.delegate);
  return { ...entryInput({ entry: value.entry, root: value.root, oids: value.oids }), delegate: value.delegate };
}
function marker(value: EntryClosure): void {
  identity(value.id, value.root);
  if (value.version !== 1 || orderIds(value.oids).sort().join() !== value.oids.join()) fail("invalid entry marker");
}
export function closureRecord(value: unknown): asserts value is EntryClosure {
  shape(value, "version,id,root,oids"); marker(value as unknown as EntryClosure);
}
export function armRecord(value: unknown): asserts value is EntryArm {
  shape(value, "version,id,root,oids,delegate"); marker(value as unknown as EntryArm); delegate(value.delegate);
}
export function sameMarker(saved: EntryClosure, input: EntryInput): void {
  if (saved.root !== input.root || saved.oids.join() !== input.ids.join()) fail("entry marker binds another root or member set");
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
      const closed = state.closures.some(c => c.id === e.id) || state.supersessions.some(s => s.entry === e.id);
      if (!o || o.handle !== b.handle || o.recipient !== b.recipient || (!closed && (!postIssuance(o) || orders.has(o.id))))
        fail("invalid issuance entry relationship");
      if (!closed) orders.add(o.id); spaces.add(o.space);
    }
    if (spaces.size !== 1) fail("issuance entry spans spaces");
  }
  for (const collection of [state.closures, state.arms]) {
    const seen = new Set<string>();
    for (const m of collection) {
      const entry = state.entries.find(e => e.id === m.id);
      if (seen.has(m.id)) fail("duplicate entry marker"); seen.add(m.id);
      const bindings = m.oids.map(id => state.orders.find(o => o.id === id));
      if (bindings.some(o => !o) || new Set(bindings.map(o => o!.space)).size !== 1) fail("invalid entry marker relationship");
      if (entry) sameEntry(entry, { id: m.id, root: m.root, ids: m.oids });
      if (collection === state.arms && (!entry || state.closures.some(c => c.id === m.id))) fail("armed entry is absent or closed");
    }
  }
}
