import type { DatabaseSync } from "node:sqlite";
import { ENVELOPE_MAX_BYTES, ENVELOPE_MAX_HEAD, ENVELOPE_PREFIX_MAX_BYTES,
  inspectEnvelopePrefix, readJournalPayload, type EnvelopeRecord } from "./journal-envelope.ts";
import type { Change, Json } from "./codec.ts";

export interface OutboxEnvelope {
  readonly record: EnvelopeRecord;
  /** Historical SQLite marker only, never a live off-host/effect proof. */
  readonly historicalAcknowledged: boolean;
}
const equal = (a: OutboxEnvelope, b: OutboxEnvelope) => Buffer.from(a.record.bytes).equals(b.record.bytes);
export interface EnvelopeProjection {
  readonly validation: "envelope-projection-only";
  readonly kind: string; readonly key: string; readonly value: Json; readonly seq: number;
  readonly historicalAcknowledged: boolean;
}
interface Projected { readonly change: Change; readonly seq: number; readonly historicalAcknowledged: boolean; readonly text: string }
const identity = (kind: string, key: string) => JSON.stringify([kind, key]);
function projectionValue(text: string): Json {
  const value = JSON.parse(text) as Json, pending: Json[] = [value];
  while (pending.length) {
    const current = pending.pop()!;
    if (current !== null && typeof current === "object") {
      for (const child of Object.values(current)) pending.push(child);
      Object.freeze(current);
    }
  }
  return value;
}

/** Internal fixed-profile engine, never a caller SQL/transaction interface. */
class EnvelopeSqlite {
  private readonly db: DatabaseSync;
  private readonly withProjection: boolean;
  readonly store: string;
  private accepted: readonly OutboxEnvelope[] = [];
  private unusable = false;
  protected constructor(db: DatabaseSync, store: string, withProjection: boolean) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(store)) throw Error("invalid outbox store identity");
    this.db = db; this.store = store; this.withProjection = withProjection; this.profile();
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
    const tables = this.db.prepare("select name,type from main.sqlite_schema where type in ('table','view') and name not glob 'sqlite_*' order by name").all();
    if (tables.map(row => row.name).join() !== (this.withProjection ? "outbox,records" : "outbox") || tables.some(row => row.type !== "table"))
      throw Error(this.withProjection ? "requires an isolated outbox and records database" : "requires an isolated outbox-only database");
    const columns = this.db.prepare("pragma main.table_xinfo(outbox)").all();
    if (columns.length !== 3 || columns.some((c, i) => c.name !== ["seq", "payload", "acknowledged"][i] ||
        String(c.type).toUpperCase() !== ["INTEGER", "TEXT", "INTEGER"][i] || c.hidden !== 0 ||
        c.pk !== (i === 0 ? 1 : 0) || i > 0 && c.notnull !== 1))
      throw Error("unsupported outbox table shape");
    if (this.withProjection) {
      const recordColumns = this.db.prepare("pragma main.table_xinfo(records)").all();
      const table = this.db.prepare("pragma main.table_list").all().find(row => row.name === "records");
      if (table?.wr !== 0 || recordColumns.length !== 4 || recordColumns.some((c, i) =>
          c.name !== ["kind", "key", "value", "seq"][i] || String(c.type).toUpperCase() !== ["TEXT", "TEXT", "TEXT", "INTEGER"][i] ||
          c.hidden !== 0 || c.notnull !== 1 || c.pk !== (i < 2 ? i + 1 : 0))) throw Error("unsupported projection table shape");
      const primary = this.db.prepare("pragma main.index_list(records)").all().find(row => row.origin === "pk");
      if (typeof primary?.name !== "string") throw Error("unsupported projection primary key");
      const identities = this.db.prepare("select name,coll from pragma_index_xinfo(?, 'main') where key=1 order by seqno").all(primary.name);
      if (identities.map(row => row.name).join() !== "kind,key" || identities.some(row => String(row.coll).toUpperCase() !== "BINARY"))
        throw Error("projection primary key must preserve exact binary identities");
    }
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
  private derive(rows: readonly OutboxEnvelope[]): Map<string, Projected> {
    const result = new Map<string, Projected>();
    for (const row of rows) for (const change of row.record.entry.changes) {
      if (Buffer.from(change.key).toString("utf8") !== change.key) throw Error("projection key cannot be represented losslessly");
      const text = JSON.stringify(change.value);
      result.set(identity(change.kind, change.key), { change, text, seq: row.record.entry.seq,
        historicalAcknowledged: row.historicalAcknowledged });
    }
    return result;
  }
  private validateProjection(rows: readonly OutboxEnvelope[]): void {
    const expected = this.derive(rows), seen = new Set<string>();
    const keys = this.db.prepare("select cast(kind as blob) as kind,cast(key as blob) as key from main.records where rowid=?");
    const values = this.db.prepare("select cast(value as blob) as value from main.records where rowid=?");
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    for (const row of this.db.prepare("select rowid as slot,typeof(kind) as kt,length(cast(kind as blob)) as kb," +
      "typeof(key) as it,length(cast(key as blob)) as ib,typeof(value) as vt,length(cast(value as blob)) as vb," +
      "seq,typeof(seq) as st from main.records").iterate()) {
      if (seen.size >= expected.size || typeof row.slot !== "number" || !Number.isSafeInteger(row.slot) ||
          row.kt !== "text" || row.it !== "text" || row.vt !== "text" || row.st !== "integer" ||
          typeof row.kb !== "number" || row.kb < 1 || row.kb > 32 || typeof row.ib !== "number" || row.ib < 1 || row.ib > 1024)
        throw Error("invalid projection row or bounds");
      const raw = keys.get(row.slot);
      if (!(raw?.kind instanceof Uint8Array) || raw.kind.length !== row.kb ||
          !(raw.key instanceof Uint8Array) || raw.key.length !== row.ib) throw Error("projection identity changed during read");
      const key = identity(decoder.decode(raw.kind), decoder.decode(raw.key)), value = expected.get(key);
      if (!value || seen.has(key) || row.seq !== value.seq || row.vb !== Buffer.byteLength(value.text))
        throw Error("projection differs from exact history");
      const bytes = values.get(row.slot)?.value;
      if (!(bytes instanceof Uint8Array) || !Buffer.from(bytes).equals(Buffer.from(value.text)))
        throw Error("projection value differs from exact history");
      seen.add(key);
    }
    if (seen.size !== expected.size) throw Error("projection history is incomplete");
  }
  private project(before: readonly OutboxEnvelope[], after: readonly OutboxEnvelope[]): void {
    const prior = this.derive(before), next = this.derive(after);
    const put = this.db.prepare("insert into main.records(kind,key,value,seq) values(?,?,?,?) " +
      "on conflict(kind,key) do update set value=excluded.value,seq=excluded.seq");
    for (const [key, row] of next) if (prior.get(key)?.seq !== row.seq)
      put.run(row.change.kind, row.change.key, row.text, row.seq);
  }
  private operate(write: boolean, work: (before: readonly OutboxEnvelope[]) => readonly OutboxEnvelope[]): readonly OutboxEnvelope[] {
    this.profile(); this.db.exec(write ? "begin immediate" : "begin");
    try {
      const before = this.scan(); this.retained(before);
      if (this.withProjection) this.validateProjection(before);
      const expected = work(before);
      if (write && this.withProjection) this.project(before, expected);
      const after = write ? this.scan() : before;
      if (after.length !== expected.length || expected.some((row, i) => !equal(row, after[i]!) ||
          row.historicalAcknowledged !== after[i]!.historicalAcknowledged)) throw Error("outbox transaction readback differs");
      if (this.withProjection) this.validateProjection(after);
      this.db.exec("commit"); this.accepted = after; return after;
    } catch (error) {
      if (this.db.isTransaction) { try { this.db.exec("rollback"); } catch { this.unusable = true; } }
      throw error;
    }
  }
  read(): readonly OutboxEnvelope[] { return this.operate(false, rows => rows); }
  protected projectionView(): readonly EnvelopeProjection[] {
    let result: readonly EnvelopeProjection[] = [];
    this.operate(false, rows => {
      result = Object.freeze([...this.derive(rows).values()].map(row => Object.freeze({
        validation: "envelope-projection-only" as const, kind: row.change.kind, key: row.change.key,
        value: projectionValue(row.text), seq: row.seq, historicalAcknowledged: row.historicalAcknowledged })));
      return rows;
    });
    return result;
  }
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

/** Dormant outbox-only profile. No caller option admits projection tables. */
export class EnvelopeOutbox extends EnvelopeSqlite {
  constructor(db: DatabaseSync, store: string) { super(db, store, false); }
}

/** Dormant fixed outbox+records profile. Generic derived projection only, never
 * a domain/operation validator, active-store opener or external-effect gate. */
export class EnvelopeProjectionStore extends EnvelopeSqlite {
  constructor(db: DatabaseSync, store: string) { super(db, store, true); }
  projected(): readonly EnvelopeProjection[] { return this.projectionView(); }
  get(kind: string, key: string): EnvelopeProjection | null {
    return this.projectionView().find(row => row.kind === kind && row.key === key) ?? null;
  }
}
