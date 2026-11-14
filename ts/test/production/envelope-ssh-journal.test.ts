import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { EnvelopeSshJournal } from "../../src/storage/envelope-ssh-journal.ts";
import { RecoveryCommand, JOURNAL_PAGE_ENTRIES, JOURNAL_PAGE_BYTES } from "../../src/storage/ssh-journal.ts";
import { encodeJournalEnvelope, readJournalPayload, ENVELOPE_MAX_BYTES } from "../../src/storage/journal-envelope.ts";
import { entry } from "../../src/storage/codec.ts";

const fixture = JSON.parse(readFileSync(new URL("journal-envelope-vectors.json", import.meta.url), "utf8")) as {
  store: string; records: { name: string; payload: string }[] };
const sha = (raw: Uint8Array | string) => createHash("sha256").update(raw).digest("hex");
function vector(name: string) { const v = fixture.records.find(v => v.name === name); assert(v); return Buffer.from(v.payload); }
const floor = vector("floor-first"), legacy = vector("legacy-compact");
function successor(raw = floor, value: string | number = 1) {
  const e = readJournalPayload(raw).entry;
  return Buffer.from(encodeJournalEnvelope(fixture.store, e.seq + 1, e.hash, [{ kind: "data", key: "value", value }]).bytes);
}
interface Item { sequence: number; sha256: string; remoteSha256: string; data: string }
interface Page { ok: true; entries: Item[]; head: number }
class Controlled extends RecoveryCommand {
  rows: Buffer[]; pageSize = JOURNAL_PAGE_ENTRIES; online = true; salt = "original";
  calls: Record<string, unknown>[] = [];
  hook?: (request: Record<string, unknown>, response: unknown) => unknown;
  constructor(rows: readonly Uint8Array[] = []) { super("/unused-node", "/unused-client", "/unused-config"); this.rows = rows.map(row => Buffer.from(row)); }
  item(index: number): Item {
    const raw = this.rows[index]!;
    return { sequence: index + 1, sha256: sha(raw), remoteSha256: sha(this.salt + raw.toString("base64")), data: raw.toString("base64") };
  }
  override request<T>(input: object): T {
    const request = input as Record<string, unknown>; this.calls.push(request);
    if (!this.online) throw Error("controlled transport unavailable");
    let response: unknown;
    if (request.op === "journal-read") {
      const after = Number(request.after);
      response = { ok: true, head: this.rows.length, entries: this.rows.slice(after, after + this.pageSize).map((_, i) => this.item(after + i)) };
    } else if (request.op === "journal-head") {
      const last = this.rows.length ? this.item(this.rows.length - 1) : undefined;
      response = { ok: true, sequence: this.rows.length, sha256: last?.sha256 ?? null, remoteSha256: last?.remoteSha256 ?? null };
    } else {
      assert.equal(request.op, "journal-append"); const seq = Number(request.sequence), raw = Buffer.from(request.data as string, "base64");
      if (seq <= this.rows.length) assert.deepEqual(raw, this.rows[seq - 1]); else { assert.equal(seq, this.rows.length + 1); this.rows.push(raw); }
      const saved = this.item(seq - 1); response = { ok: true, sequence: seq, sha256: saved.sha256, remoteSha256: saved.remoteSha256 };
    }
    return (this.hook ? this.hook(request, response) : response) as T;
  }
}

test("SSH envelope read validates a fresh empty head and returns owned immutable byte views", () => {
  const command = new Controlled(), journal = new EnvelopeSshJournal(command);
  assert.deepEqual(journal.read(), []); assert.deepEqual(command.calls.map(c => c.op), ["journal-read", "journal-head"]);
  command.rows.push(floor); const records = journal.read(); assert(Object.isFrozen(records));
  assert.equal(records[0]!.validation, "envelope-only"); records[0]!.bytes.fill(0);
  assert.deepEqual(journal.read()[0]!.bytes, Uint8Array.from(floor));
  assert.throws(() => { (records as unknown[]).pop(); });
});

test("new append and historical retry send exact bytes and re-read complete live history", () => {
  const command = new Controlled(), journal = new EnvelopeSshJournal(command), raw = Buffer.from(floor);
  journal.append(raw); raw.fill(0); journal.append(successor()); command.calls.length = 0; journal.append(floor);
  assert.deepEqual(command.calls.map(c => c.op), ["journal-read", "journal-head", "journal-append", "journal-read", "journal-head"]);
  const send = command.calls[2]!; assert.equal(send.sha256, sha(floor)); assert.equal(send.data, floor.toString("base64"));
  assert.equal(journal.read().length, 2);
});

test("legacy remote payload LF and spelling stay exact while differing same-hash retries refuse", () => {
  const raw = Buffer.concat([vector("legacy-duplicate-exponent"), Buffer.from("\n")]);
  const command = new Controlled([raw]), journal = new EnvelopeSshJournal(command);
  journal.append(raw); assert.equal(journal.read()[0]!.payload, raw.toString());
  assert.throws(() => journal.append(raw.subarray(0, -1)), /retry bytes differ/);
  assert.throws(() => new EnvelopeSshJournal(new Controlled()).append(legacy), /new legacy/);
  assert.equal(command.calls.filter(c => c.op === "journal-append").length, 1);
  journal.append(encodeJournalEnvelope(fixture.store, 2, readJournalPayload(raw).entry.hash, readJournalPayload(floor).entry.changes).bytes);
  journal.append(raw); assert.deepEqual(command.rows[0], raw);
});

test("retained plaintext, encrypted identity and history disappearance fail without changing old views", () => {
  for (const mutation of ["payload", "cipher", "truncate"]) {
    const command = new Controlled([legacy]), journal = new EnvelopeSshJournal(command), saved = journal.read();
    if (mutation === "payload") command.rows[0] = vector("legacy-pretty");
    if (mutation === "cipher") command.salt = "re-encrypted";
    if (mutation === "truncate") command.rows.length = 0;
    assert.throws(() => journal.read(), /retained/); assert.equal(saved[0]!.payload, legacy.toString());
  }
});

test("transport loss refuses cached reads/retries and post-publication loss remains exactly retryable", () => {
  const command = new Controlled([floor]), journal = new EnvelopeSshJournal(command); journal.read(); command.online = false;
  assert.throws(() => journal.read(), /unavailable/); assert.throws(() => journal.append(floor), /unavailable/); command.online = true;
  command.hook = (request, response) => { if (request.op === "journal-append") command.online = false; return response; };
  const raw = successor(); assert.throws(() => journal.append(raw), /unavailable/); assert.equal(command.rows.length, 2);
  command.online = true; delete command.hook; journal.append(raw); assert.equal(journal.read().length, 2);
});

test("malformed acknowledgments never count as confirmed publication", () => {
  for (const changed of [{ ok: false }, { sequence: 2 }, { sha256: "0".repeat(64) }, { remoteSha256: null }, { unexpected: true }]) {
    const command = new Controlled(); command.hook = (r, result) => r.op === "journal-append" ? { ...(result as object), ...changed } : result;
    assert.throws(() => new EnvelopeSshJournal(command).append(floor), /acknowledgment|fields/);
    assert.equal(command.rows.length, 1); // An exception is not proof of absence.
  }
});

test("post-append target/receipt mismatch or an unexpected extension refuses success", () => {
  const change = readJournalPayload(floor).entry.changes[0]!, value = change.value;
  assert(value && typeof value === "object" && !Array.isArray(value));
  const alternative = Buffer.from(encodeJournalEnvelope(fixture.store, 1, null,
    [{ ...change, value: { ...value, capabilityDigest: "1".repeat(64) } }]).bytes);
  for (const fault of ["receipt", "payload", "extra", "missing"]) {
    const command = new Controlled(); command.hook = (request, response) => {
      if (request.op === "journal-append") {
        if (fault === "receipt") return { ...(response as object), remoteSha256: "0".repeat(64) };
        if (fault === "payload") command.rows[0] = alternative;
        if (fault === "extra") command.rows.push(successor());
        if (fault === "missing") command.rows.length = 0;
      }
      return response;
    };
    assert.throws(() => new EnvelopeSshJournal(command).append(floor), /readback/);
  }
});

test("strict page and item shapes, base64, plaintext digest and envelope sequence refuse malformed replies", () => {
  const variants: ((page: Page) => unknown)[] = [() => null, page => ({ ...page, ok: false }), page => ({ ...page, extra: true }),
    page => ({ ...page, head: "1" }), page => ({ ...page, head: -1 }), page => ({ ...page, head: 1_000_001 }),
    page => ({ ...page, entries: [] }), page => ({ ...page, head: 0 }),
    ...[{ sequence: 2 }, { sha256: "0".repeat(64) }, { remoteSha256: "bad" }, { data: floor.toString("base64") + "\n" }, { data: 1 }, { extra: 1 }]
      .map(changed => (page: Page) => ({ ...page, entries: [{ ...page.entries[0], ...changed }] }))];
  for (const change of variants) {
    const command = new Controlled([floor]); command.hook = (r, response) => r.op === "journal-read" ? change(response as Page) : response;
    assert.throws(() => new EnvelopeSshJournal(command).read());
  }
  const badSequence = new Controlled([successor()]); assert.throws(() => new EnvelopeSshJournal(badSequence).read(), /sequence/);
});

test("page-head drift and final head changes refuse a previously parsed prefix", () => {
  for (const fault of ["page-head", "head-count", "head-plain", "head-cipher", "empty-head-null"]) {
    const command = new Controlled(fault === "empty-head-null" ? [] : [floor, successor()]); command.pageSize = 1;
    command.hook = (r, response) => {
      if (fault === "page-head" && r.op === "journal-read" && r.after === 1) return { ...(response as object), head: 3 };
      if (r.op === "journal-head") return { ...(response as object), ...(fault === "head-count" ? { sequence: 3 }
        : fault === "head-plain" || fault === "empty-head-null" ? { sha256: "0".repeat(64) }
        : fault === "head-cipher" ? { remoteSha256: "0".repeat(64) } : {}) };
      return response;
    };
    assert.throws(() => new EnvelopeSshJournal(command).read(), /head|prefix/);
  }
});

test("large and earlier byte-bounded pages keep all original records and enforce count limits", () => {
  const rows = [floor]; for (let i = 1; i <= JOURNAL_PAGE_ENTRIES; i++) rows.push(successor(rows.at(-1)!, i));
  for (const size of [JOURNAL_PAGE_ENTRIES, 5000]) {
    const command = new Controlled(rows); command.pageSize = size;
    const records = new EnvelopeSshJournal(command).read(); assert.equal(records.length, rows.length);
    assert.deepEqual(command.calls.filter(c => c.op === "journal-read").map(c => c.after), [0, size]);
    assert.equal(records.at(-1)!.payload, rows.at(-1)!.toString());
  }
  const excessive = new Controlled(rows); excessive.pageSize = rows.length; assert.throws(() => new EnvelopeSshJournal(excessive).read(), /prefix/);
});

test("record and decoded-page byte limits are checked before accepting the prefix", () => {
  const oversized = new Controlled([floor]); oversized.hook = (r, response) => r.op === "journal-read"
    ? { ...(response as Page), entries: [{ ...oversized.item(0), data: "A".repeat(4 * Math.ceil(ENVELOPE_MAX_BYTES / 3) + 4) }] } : response;
  assert.throws(() => new EnvelopeSshJournal(oversized).read(), /record/);
  const first = entry(fixture.store, 1, null, [{ kind: "data", key: "large", value: "x".repeat(JOURNAL_PAGE_BYTES / 2) }]);
  const second = entry(fixture.store, 2, first.hash, [{ kind: "data", key: "large", value: "y".repeat(JOURNAL_PAGE_BYTES / 2) }]);
  assert.throws(() => new EnvelopeSshJournal(new Controlled([Buffer.from(JSON.stringify(first)), Buffer.from(JSON.stringify(second))])).read(), /byte bounds/);
});

test("structural floor, downgrade, identity and lineage validation precedes sending", () => {
  const command = new Controlled(), journal = new EnvelopeSshJournal(command);
  assert.throws(() => journal.append(successor()), /lineage/);
  const ordinary = encodeJournalEnvelope(fixture.store, 1, null, [{ kind: "data", key: "ordinary", value: 1 }]);
  assert.throws(() => journal.append(ordinary.bytes), /floor/); assert.equal(command.calls.filter(c => c.op === "journal-append").length, 0);
  journal.append(floor);
  assert.throws(() => journal.append(encodeJournalEnvelope(fixture.store, 2, readJournalPayload(floor).entry.hash, readJournalPayload(floor).entry.changes).bytes), /repeated/);
  const foreign = encodeJournalEnvelope("00000000-0000-0000-0000-000000000000", 2, readJournalPayload(floor).entry.hash, [{ kind: "data", key: "x", value: 1 }]);
  assert.throws(() => journal.append(foreign.bytes), /lineage/);
  command.rows.push(Buffer.from(JSON.stringify(entry(fixture.store, 2, readJournalPayload(floor).entry.hash, [{ kind: "data", key: "x", value: 1 }]))));
  assert.throws(() => journal.read(), /legacy/);
});
