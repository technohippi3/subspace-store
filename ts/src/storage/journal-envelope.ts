import { createHash } from "node:crypto";
import { decode as legacyDecode, type Change, type Entry } from "./codec.ts";
import { canonicalJson } from "./journal-canonical.ts";

export const ENVELOPE_MAX_BYTES = 16 * 1024 * 1024;
export const ENVELOPE_PREFIX_MAX_BYTES = 512 * 1024 * 1024;
export const ENVELOPE_MAX_HEAD = 1_000_000;
const frame = "SSSJ2 ";
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type EnvelopeEntry = Entry | (Omit<Entry, "version"> & { readonly version: 2 });
export interface EnvelopeRecord {
  readonly validation: "envelope-only";
  readonly payload: string;
  readonly bytes: Uint8Array;
  readonly entry: EnvelopeEntry;
  readonly recordDigest: string;
}
function object(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
    throw Error("invalid journal fields");
}
function freeze<T extends object>(value: T): T {
  const pending: object[] = [value];
  while (pending.length) {
    const item = pending.pop()!;
    for (const child of Object.values(item)) if (child !== null && typeof child === "object") pending.push(child);
    Object.freeze(item);
  }
  return value;
}
function versionTwo(value: unknown): EnvelopeEntry {
  object(value, "changes,hash,previous,seq,store,version");
  if (value.version !== 2 || !uuid(value.store) || !Number.isSafeInteger(value.seq) ||
      (value.seq as number) < 1 || (value.seq as number) > ENVELOPE_MAX_HEAD || !hex(value.hash) ||
      (value.seq === 1 ? value.previous !== null : !hex(value.previous)) ||
      !Array.isArray(value.changes) || !value.changes.length) throw Error("invalid journal envelope");
  const seen = new Set<string>();
  for (const change of value.changes) {
    object(change, "key,kind,value");
    if (typeof change.kind !== "string" || !/^[a-z][a-z_]{0,31}$/.test(change.kind) ||
        typeof change.key !== "string" || !change.key.length || change.key.length > 256)
      throw Error("invalid journal change");
    const key = JSON.stringify([change.kind, change.key]);
    if (seen.has(key)) throw Error("duplicate journal change"); seen.add(key);
  }
  if (sha(canonicalJson([2, value.store, value.seq, value.previous, value.changes])) !== value.hash)
    throw Error("journal checksum mismatch");
  return value as unknown as EnvelopeEntry;
}
/** Syntax, canonical encoding and embedded hash only. Domain/authority checks
 * are deliberately separate. This module is not selected by any backend. */
export function readJournalPayload(input: Uint8Array): EnvelopeRecord {
  if (!(input instanceof Uint8Array) || !input.length || input.length > ENVELOPE_MAX_BYTES)
    throw Error("journal payload exceeds bounds");
  const raw = Buffer.from(input);
  const payload = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  let entry: EnvelopeEntry;
  if (payload.startsWith(frame)) {
    const body = payload.slice(frame.length);
    let value: unknown;
    try { value = JSON.parse(body); } catch { throw Error("invalid journal JSON"); }
    if (canonicalJson(value) !== body) throw Error("noncanonical journal envelope");
    entry = versionTwo(value);
  } else {
    try { entry = legacyDecode(payload); } catch { throw Error("invalid legacy journal envelope"); }
    if (entry.seq > ENVELOPE_MAX_HEAD) throw Error("journal head exceeds bounds");
  }
  freeze(entry);
  return Object.freeze({ validation: "envelope-only" as const, payload, entry, recordDigest: sha(raw),
    get bytes(): Uint8Array { return Uint8Array.from(raw); } });
}
/** Remove only the physical file LF. Remote/outbox payloads use the other API. */
export function readJournalFile(input: Uint8Array): EnvelopeRecord {
  if (!(input instanceof Uint8Array) || !input.length || input.length > ENVELOPE_MAX_BYTES + 1)
    throw Error("journal file exceeds bounds");
  const raw = Buffer.from(input), lf = raw.at(-1) === 10;
  if (raw.subarray(0, frame.length).toString() === frame && !lf) throw Error("new journal file requires LF");
  return readJournalPayload(lf ? raw.subarray(0, -1) : raw);
}
/** Pure v2 construction. It grants no append, floor or operation permission. */
export function encodeJournalEnvelope(store: string, seq: number, previous: string | null,
                                      changes: readonly Change[]): EnvelopeRecord {
  const hash = sha(canonicalJson([2, store, seq, previous, changes]));
  return readJournalPayload(Buffer.from(frame + canonicalJson({ version: 2, store, seq, previous, changes, hash })));
}
/** Only new v2 file construction; this cannot normalize/rewrite a legacy file. */
export function journalFileBytes(record: EnvelopeRecord): Uint8Array {
  const verified = readJournalPayload(record.bytes);
  if (verified.entry.version !== 2) throw Error("legacy file construction is unsupported");
  return Buffer.concat([verified.bytes, Buffer.from("\n")]);
}
export interface EnvelopeFloor {
  readonly version: 2; readonly requires: readonly ["store_operation_ownership_v1"];
  readonly installation: string; readonly authorityIdentity: string; readonly capabilityDigest: string;
}
function floor(value: EnvelopeEntry): EnvelopeFloor {
  if (value.changes.length !== 1) throw Error("floor must be a singleton");
  const change = value.changes[0]!;
  if (change.kind !== "store_protocol" || change.key !== "required") throw Error("store floor required");
  const body: unknown = change.value;
  object(body, "authorityIdentity,capabilityDigest,installation,requires,version");
  if (body.version !== 2 || !Array.isArray(body.requires) || body.requires.length !== 1 ||
      body.requires[0] !== "store_operation_ownership_v1" || typeof body.installation !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(body.installation) || !hex(body.authorityIdentity) || !hex(body.capabilityDigest))
    throw Error("unsupported store floor");
  return body as unknown as EnvelopeFloor;
}
export interface EnvelopePrefix {
  readonly validation: "envelope-only";
  readonly store: string | null; readonly head: number; readonly hash: string | null;
  readonly floorSequence: number | null; readonly floor: EnvelopeFloor | null;
}
/** Structural streaming inspection, not typed projection, acknowledgment,
 * authenticated configuration matching, incarnation custody or activation. */
export function inspectEnvelopePrefix(payloads: Iterable<Uint8Array>): EnvelopePrefix {
  let store: string | null = null, hash: string | null = null, head = 0, bytes = 0;
  let protocol: EnvelopeFloor | null = null, floorSequence: number | null = null;
  for (const payload of payloads) {
    bytes += payload.byteLength;
    if (bytes > ENVELOPE_PREFIX_MAX_BYTES || head >= ENVELOPE_MAX_HEAD) throw Error("journal prefix exceeds bounds");
    const entry = readJournalPayload(payload).entry;
    if (entry.seq !== head + 1 || entry.previous !== hash || store !== null && entry.store !== store)
      throw Error("journal prefix lineage mismatch");
    const marker = entry.changes.some(change => change.kind === "store_protocol");
    if (entry.version === 1) {
      if (protocol || marker) throw Error("legacy journal cannot carry or follow the floor");
    } else if (!protocol) { protocol = floor(entry); floorSequence = entry.seq; }
    else if (marker) throw Error("repeated store floor");
    store = entry.store; hash = entry.hash; head++;
  }
  return Object.freeze({ validation: "envelope-only", store, head, hash, floorSequence, floor: protocol });
}
