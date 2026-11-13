import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { json, type Json } from "../storage/codec.ts";
import { JOURNAL_PAGE_BYTES, JOURNAL_PAGE_ENTRIES, type RecoveryCommand } from "../storage/ssh-journal.ts";
import { batch, type Batch } from "./records.ts";
import { strictJson } from "./json.ts";
import { refuse } from "./errors.ts";
import { guardRecord } from "./rebuild-policy.ts";

export interface ControllerEvent { readonly seq: number; readonly kind: string; readonly [key: string]: Json }
/** Existing Python controller envelope; store DurableStore envelopes are distinct. */
export interface ControllerJournal {
  entries(): readonly ControllerEvent[];
  append(value: Batch): void;
  appendEvent(kind: string, data: Readonly<Record<string, Json>>): void;
}
const maximumBytes = 512 * 1024 * 1024;
function utf8(raw: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { return refuse("invalid controller journal UTF-8", "invalid"); }
}
function decode(raw: string, sequence: number): ControllerEvent {
  const value = strictJson(raw);
  try { json(value); } catch { return refuse("invalid controller journal JSON value", "invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.seq !== sequence ||
      typeof value.kind !== "string" || !/^[a-z][a-z_]{0,63}$/.test(value.kind)) refuse("invalid controller journal envelope", "invalid");
  if (value.kind === "batch") {
    if (Object.keys(value).sort().join() !== "batch,kind,seq") refuse("invalid controller batch envelope", "invalid");
    batch(value.batch);
  }
  if (value.kind === "rebuild_guard") guardRecord(value);
  return value as ControllerEvent;
}
export function latest(entries: readonly ControllerEvent[]): Map<string, Batch> {
  const result = new Map<string, Batch>();
  for (const event of entries) if (event.kind === "batch") {
    const value = batch(event.batch); result.set(value.bid, value);
  }
  return result;
}
function eventData(kind: string, data: Readonly<Record<string, Json>>): Record<string, Json> {
  if (Object.hasOwn(data, "seq") || Object.hasOwn(data, "kind")) refuse("reserved controller event fields", "invalid");
  const value = { kind, ...data }; decode(JSON.stringify({ seq: 1, ...value }), 1); return value;
}
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

/** Python JSONL compatibility. A dedicated existing off-host directory is required.
 * No directory is created and a .down marker never falls back to local authority. */
export class FileControllerJournal implements ControllerJournal {
  private prefix: string[] = [];
  readonly path: string;
  private readonly directory: string;
  private readonly unavailableMarker: string;
  constructor(directory: string, name = "controller") {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !statSync(directory).isDirectory()) refuse("invalid controller journal directory", "invalid");
    this.directory = directory; this.path = join(directory, name + ".jsonl"); this.unavailableMarker = join(directory, name + ".down");
  }
  entries(): readonly ControllerEvent[] {
    if (existsSync(this.unavailableMarker)) refuse("controller journal unavailable", "unavailable");
    if (existsSync(this.path) && statSync(this.path).size > maximumBytes) refuse("controller journal exceeds replay bounds", "invalid");
    const text = existsSync(this.path) ? utf8(readFileSync(this.path)) : "";
    if (text && !text.endsWith("\n")) refuse("truncated controller journal", "invalid");
    const lines = text ? text.slice(0, -1).split("\n") : [];
    if (lines.length > 1_000_000 || lines.length < this.prefix.length || this.prefix.some((raw, i) => lines[i] !== raw))
      refuse("controller journal prefix changed", "invalid");
    const entries = lines.map((raw, i) => decode(raw, i + 1));
    // A surviving append is acknowledged only after both file and directory sync.
    if (existsSync(this.path)) { const fd = openSync(this.path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
    this.syncDirectory(); this.prefix = lines; return entries;
  }
  append(value: Batch): void {
    this.appendEvent("batch", { batch: batch(value) as unknown as Json });
  }
  appendEvent(kind: string, data: Readonly<Record<string, Json>>): void {
    const value = eventData(kind, data), before = this.entries(), raw = JSON.stringify({ seq: before.length + 1, ...value });
    const fd = openSync(this.path, "a", 0o600);
    try { writeFileSync(fd, raw + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    this.syncDirectory();
    const entries = this.entries();
    if (entries.length !== before.length + 1 || this.prefix.at(-1) !== raw) refuse("controller journal readback differs", "unavailable");
  }
  private syncDirectory(): void {
    const fd = openSync(this.directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

/** Uses the shipped recovery client's authenticated controller stream protocol.
 * Pending exact bytes survive a lost reply within this instance; no alternate backend. */
export class RemoteControllerJournal implements ControllerJournal {
  private pending: { value: string; sequence: number; raw: string } | undefined;
  private prefix: string[] = [];
  private readonly command: Pick<RecoveryCommand, "request">;
  constructor(command: Pick<RecoveryCommand, "request">) { this.command = command; }
  entries(): readonly ControllerEvent[] {
    // Policy must never derive its next count/reset from history that excludes
    // this instance's unresolved exact event (including a loss before forwarding).
    if (this.pending) this.confirmPending();
    return this.readEntries();
  }
  private readEntries(): readonly ControllerEvent[] {
    const entries: ControllerEvent[] = [], prefix: string[] = []; let after = 0, bytes = 0, head: number | undefined;
    while (true) {
      const page = this.command.request<{ head: number; entries: { sequence: number; sha256: string; data: string }[] }>({
        op: "journal-read", stream: "controller", after, limit: JOURNAL_PAGE_ENTRIES });
      if (!page || typeof page !== "object" || !Number.isSafeInteger(page.head) || page.head < after || page.head > 1_000_000 ||
          head !== undefined && head !== page.head || !Array.isArray(page.entries) || page.entries.length > JOURNAL_PAGE_ENTRIES)
        refuse("controller journal prefix changed or exceeds replay bounds", "invalid");
      head = page.head; let pageBytes = 0;
      for (const item of page.entries) {
        if (!item || typeof item !== "object" || typeof item.data !== "string") refuse("invalid controller journal object", "invalid");
        const raw = Buffer.from(item.data, "base64"); bytes += raw.length; pageBytes += raw.length;
        if (raw.toString("base64") !== item.data || pageBytes > JOURNAL_PAGE_BYTES || bytes > maximumBytes ||
            item.sequence !== after + 1 || item.sha256 !== digest(raw)) refuse("controller journal digest or sequence differs", "invalid");
        const text = utf8(raw);
        entries.push(decode(text, ++after)); prefix.push(text);
      }
      if (after === head) break;
      if (!page.entries.length || after > head) refuse("controller journal prefix incomplete", "invalid");
    }
    if (prefix.length < this.prefix.length || this.prefix.some((raw, i) => prefix[i] !== raw)) refuse("controller journal prefix changed", "invalid");
    this.prefix = prefix; return entries;
  }
  append(value: Batch): void {
    this.appendEvent("batch", { batch: batch(value) as unknown as Json });
  }
  appendEvent(kind: string, data: Readonly<Record<string, Json>>): void {
    const value = eventData(kind, data), encoded = JSON.stringify(value), previous = this.pending;
    if (previous) {
      // Resolve an older lost reply with the identical bytes before any different
      // event. A live read may already expose that event to policy/restart code.
      this.confirmPending(); if (previous.value === encoded) return;
    }
    const sequence = this.entries().length + 1;
    this.pending = { value: encoded, sequence, raw: JSON.stringify({ seq: sequence, ...value }) };
    this.confirmPending();
  }
  private confirmPending(): void {
    if (!this.pending) return;
    const { sequence, raw } = this.pending, sha256 = digest(raw);
    const response = this.command.request<{ sequence: number; sha256: string }>({
      op: "journal-append", stream: "controller", sequence, sha256, data: Buffer.from(raw).toString("base64") });
    if (!response || typeof response !== "object" || response.sequence !== sequence || response.sha256 !== sha256) refuse("controller journal acknowledgment differs", "unavailable");
    this.readEntries();
    if (this.prefix[sequence - 1] !== raw) refuse("controller journal readback differs", "unavailable");
    this.pending = undefined;
  }
}
