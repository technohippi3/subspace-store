import type { DatabaseSync } from "node:sqlite";
import { ENVELOPE_MAX_BYTES, ENVELOPE_MAX_HEAD, ENVELOPE_PREFIX_MAX_BYTES,
  inspectEnvelopePrefix, readJournalPayload, type EnvelopeRecord } from "./journal-envelope.ts";
import type { Change } from "./codec.ts";

export interface OutboxEnvelope {
  readonly record: EnvelopeRecord;
  /** Historical SQLite marker only, never a live off-host/effect proof. */
  readonly historicalAcknowledged: boolean;
}
const equal = (a: OutboxEnvelope, b: OutboxEnvelope) => Buffer.from(a.record.bytes).equals(b.record.bytes);

/** Dormant outbox-only SQLite boundary. Caller owns the open file/connection and
 * exclusive custody. No DDL, active store opening, domain projection or backend I/O. */
export class EnvelopeOutbox {
  private readonly db: DatabaseSync;
  readonly store: string;
  private accepted: readonly OutboxEnvelope[] = [];
  private unusable = false;
  constructor(db: DatabaseSync, store: string) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(store)) throw Error("invalid outbox store identity");
    this.db = db; this.store = store; this.profile();
  }
  private profile(): void {
    if (!this.db.isOpen || this.unusable) throw Error("outbox connection unavailable");
    if (this.db.isTransaction) throw Error("outbox does not borrow caller transactions");
    const mode = this.db.prepare("pragma main.journal_mode").get()?.journal_mode;
    if (this.db.prepare("pragma main.encoding").get()?.encoding !== "UTF-8" ||
        this.db.prepare("pragma main.synchronous").get()?.synchronous !== 2 || !["wal", "delete"].includes(mode as string))
      throw Error("unsupported outbox SQLite durability or encoding profile");
    const databases = this.db.prepare("pragma database_list").all();
    if (databases.length !== 1 || databases[0]!.name !== "main" ||
        typeof databases[0]!.file !== "string" || !databases[0]!.file.length)
      throw Error("attached or temporary databases are unsupported");
    const tables = this.db.prepare("select name,type from main.sqlite_schema where type in ('table','view') and name not glob 'sqlite_*'").all();
    if (tables.length !== 1 || tables[0]!.name !== "outbox" || tables[0]!.type !== "table")
      throw Error("requires an isolated outbox-only database");
    const columns = this.db.prepare("pragma main.table_xinfo(outbox)").all();
    if (columns.length !== 3 || columns.some((c, i) => c.name !== ["seq", "payload", "acknowledged"][i] ||
        String(c.type).toUpperCase() !== ["INTEGER", "TEXT", "INTEGER"][i] || c.hidden !== 0 ||
        c.pk !== (i === 0 ? 1 : 0) || i > 0 && c.notnull !== 1))
      throw Error("unsupported outbox table shape");
  }
  private inspect(records: readonly OutboxEnvelope[]): void {
    inspectEnvelopePrefix((function* () { for (const row of records) yield row.record.bytes; })());
    if (records.some(row => row.record.entry.store !== this.store)) throw Error("outbox store identity mismatch");
  }
  private scan(): readonly OutboxEnvelope[] {
    const rows: OutboxEnvelope[] = []; let bytes = 0, pending = false;
    const raw = this.db.prepare("select cast(payload as blob) as raw from main.outbox where seq=?");
    for (const row of this.db.prepare("select seq,typeof(payload) as storage,length(cast(payload as blob)) as bytes," +
      "acknowledged,typeof(acknowledged) as marker from main.outbox order by seq").iterate()) {
      if (rows.length >= ENVELOPE_MAX_HEAD || row.seq !== rows.length + 1 || row.storage !== "text" || row.marker !== "integer" ||
          row.acknowledged !== 0 && row.acknowledged !== 1 || typeof row.bytes !== "number" ||
          !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > ENVELOPE_MAX_BYTES)
        throw Error("invalid outbox row or bounds");
      bytes += row.bytes; if (bytes > ENVELOPE_PREFIX_MAX_BYTES) throw Error("outbox prefix exceeds byte bounds");
      if (row.acknowledged === 0) pending = true;
      else if (pending) throw Error("outbox historical markers are not a prefix");
      const payload = raw.get(row.seq)?.raw;
      if (!(payload instanceof Uint8Array) || payload.length !== row.bytes) throw Error("outbox payload changed during read");
      const record = readJournalPayload(payload);
      if (record.entry.seq !== row.seq) throw Error("outbox sequence mismatch");
      rows.push(Object.freeze({ record, historicalAcknowledged: row.acknowledged === 1 }));
    }
    this.inspect(rows); return Object.freeze(rows);
  }
  private retained(next: readonly OutboxEnvelope[]): void {
    if (next.length < this.accepted.length || this.accepted.some((row, i) => !equal(row, next[i]!) ||
        row.historicalAcknowledged && !next[i]!.historicalAcknowledged)) throw Error("retained outbox history changed or disappeared");
  }
  private operate(write: boolean, work: (before: readonly OutboxEnvelope[]) => readonly OutboxEnvelope[]): readonly OutboxEnvelope[] {
    this.profile(); this.db.exec(write ? "begin immediate" : "begin");
    try {
      const before = this.scan(); this.retained(before);
      const expected = work(before), after = write ? this.scan() : before;
      if (after.length !== expected.length || expected.some((row, i) => !equal(row, after[i]!) ||
          row.historicalAcknowledged !== after[i]!.historicalAcknowledged)) throw Error("outbox transaction readback differs");
      this.db.exec("commit"); this.accepted = after; return after;
    } catch (error) {
      if (this.db.isTransaction) { try { this.db.exec("rollback"); } catch { this.unusable = true; } }
      throw error;
    }
  }
  read(): readonly OutboxEnvelope[] { return this.operate(false, rows => rows); }
  pending(): readonly EnvelopeRecord[] { return Object.freeze(this.read().filter(row => !row.historicalAcknowledged).map(row => row.record)); }

  /** Local bytes only. Projection atomicity and off-host publication are separate. */
  append(payload: Uint8Array): undefined {
    const record = readJournalPayload(payload);
    this.operate(true, before => {
      if (record.entry.seq <= before.length) {
        if (!Buffer.from(before[record.entry.seq - 1]!.record.bytes).equals(record.bytes)) throw Error("outbox retry bytes differ");
        return before;
      }
      if (record.entry.version !== 2) throw Error("new legacy outbox writes are unsupported");
      const expected = [...before, Object.freeze({ record, historicalAcknowledged: false })]; this.inspect(expected);
      this.db.prepare("insert into main.outbox(seq,payload,acknowledged) values(?,?,0)").run(record.entry.seq, record.payload);
      return expected;
    });
  }
  /** Caller supplies an already accepted observed prefix. Marker updates are
   * historical bookkeeping, not authentication/freshness or live confirmation. */
  reconcile(payloads: Iterable<Uint8Array>): undefined {
    const observed: OutboxEnvelope[] = []; let bytes = 0;
    for (const payload of payloads) {
      if (observed.length >= ENVELOPE_MAX_HEAD || (bytes += payload.byteLength) > ENVELOPE_PREFIX_MAX_BYTES)
        throw Error("observed outbox prefix exceeds bounds");
      observed.push(Object.freeze({ record: readJournalPayload(payload), historicalAcknowledged: true }));
    }
    this.inspect(observed);
    this.operate(true, before => {
      for (const [i, row] of before.entries()) {
        if (i < observed.length && !equal(row, observed[i]!)) throw Error("outbox and observed bytes disagree");
        if (i >= observed.length && row.historicalAcknowledged) throw Error("historically acknowledged outbox entry is missing");
      }
      for (const [i, row] of observed.entries()) {
        if (i >= before.length) this.db.prepare("insert into main.outbox(seq,payload,acknowledged) values(?,?,1)").run(row.record.entry.seq, row.record.payload);
        else if (!before[i]!.historicalAcknowledged) this.db.prepare("update main.outbox set acknowledged=1 where seq=?").run(i + 1);
      }
      return [...observed, ...before.slice(observed.length)];
    });
  }
  lookup(kind: string, key: string, historicalOnly = false): Readonly<{ record: EnvelopeRecord; change: Change; historicalAcknowledged: boolean }> | null {
    const rows = this.read();
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!; if (historicalOnly && !row.historicalAcknowledged) continue;
      const change = row.record.entry.changes.find(change => change.kind === kind && change.key === key);
      if (change) return Object.freeze({ record: row.record, change, historicalAcknowledged: row.historicalAcknowledged });
    }
    return null;
  }
  head() {
    const rows = this.read(), last = rows.at(-1); let historicalAcknowledgedHead = 0;
    for (const row of rows) if (row.historicalAcknowledged) historicalAcknowledgedHead++;
    return Object.freeze({ validation: "envelope-only" as const, store: this.store, sequence: rows.length,
      hash: last?.record.entry.hash ?? null, recordDigest: last?.record.recordDigest ?? null, historicalAcknowledgedHead });
  }
}
