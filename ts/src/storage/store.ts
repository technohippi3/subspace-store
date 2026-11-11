import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, openSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Data, Effect } from "effect";
import { decode, entry, validateChanges, type Change, type Entry, type Json } from "./codec.ts";
import { FileJournal, type Journal } from "./journal.ts";
import { ownDatabase } from "./ownership.ts";

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: string; readonly reason: string; readonly message: string;
}> {}
function attempt<A>(operation: string, work: () => A): Effect.Effect<A, StorageError> {
  return Effect.try({ try: work, catch: error => {
    const reason = error instanceof Error ? error.message : "storage operation failed";
    return new StorageError({ operation, reason, message: `${operation}: ${reason}` });
  } });
}
export interface StorageConfig {
  readonly database: string;
  readonly journalDirectory: string;
  readonly restore?: boolean;
  /** Constructed after ownership; adapters must acknowledge only durable readback. */
  readonly makeJournal?: () => Journal;
}
export interface Receipt { readonly seq: number; readonly acknowledged: boolean }
export interface RecordValue { readonly value: Json; readonly seq: number; readonly acknowledged: boolean }
interface Saved { seq: number; payload: string; acknowledged: number }
const schema = `
  create table store_meta (id integer primary key check(id=1), version integer not null,
                          store text not null, restored integer not null);
  create table records (kind text not null, key text not null, value text not null,
                        seq integer not null, primary key(kind,key));
  create table outbox (seq integer primary key, payload text not null,
                       acknowledged integer not null check(acknowledged in (0,1)));
  create index outbox_pending on outbox(acknowledged,seq);
`;

/** Persistence only. Domain commands must validate their records and withhold
 * every external effect until its receipt is acknowledged. Neither this class
 * nor its journal sends Bitcoin transactions or authorizes public sales. */
export class DurableStore {
  private readonly db: DatabaseSync;
  private readonly journal: Journal;
  private readonly release: () => void;
  private readonly identity: string;
  private closed = false;
  private journalFailure: string | null = null;
  private constructor(db: DatabaseSync, journal: Journal, release: () => void, identity: string) {
    this.db = db; this.journal = journal; this.release = release; this.identity = identity;
  }
  static open(config: StorageConfig) {
    return Effect.acquireRelease(attempt("open", () => {
      const release = ownDatabase(config.database);
      let db: DatabaseSync | undefined;
      try {
        const journal = config.makeJournal?.() ?? new FileJournal(config.journalDirectory);
        const history = journal.read().map(value => decode(JSON.stringify(value)));
        const existing = existsSync(config.database);
        if (config.restore && existing) throw Error("restore never overwrites an existing database");
        if (!config.restore && !existing && history.length > 0) throw Error("restore required: journal already has history");
        if (config.restore && history.length === 0) throw Error("journal is empty; nothing to restore");
        const working = config.restore ? config.database + ".restoring" : config.database;
        if (!existsSync(working)) closeSync(openSync(working, "wx", 0o600));
        db = new DatabaseSync(working);
        const tables = db.prepare("select name from sqlite_master where type='table'").all();
        if (!tables.some(row => row.name === "store_meta")) {
          if (history.length > 0 && !config.restore) throw Error("restore required: database has no store metadata");
          if (tables.length > 0) throw Error("unsupported database; use a fresh data path or explicit import");
          db.exec("begin immediate");
          try {
            db.exec(schema);
            db.prepare("insert into store_meta values(1,1,?,?)")
              .run(history[0]?.store ?? randomUUID(), config.restore ? 1 : 0);
            db.exec("commit");
          } catch (error) { db.exec("rollback"); throw error; }
        }
        const meta = db.prepare("select * from store_meta where id=1").get();
        if (!meta || meta.version !== 1 || typeof meta.store !== "string") throw Error("unsupported storage schema");
        // Configure only after recognizing the database. Never migrate a
        // Python database or an unknown future version by opening it.
        chmodSync(working, 0o600);
        db.exec("pragma journal_mode=wal; pragma synchronous=full; pragma foreign_keys=on;");
        const store = new DurableStore(db, journal, release, meta.store);
        if (config.restore && meta.restored !== 1) throw Error("working file is not a restore");
        store.reconcile(history, config.restore ?? false);
        store.flushSync();
        if (config.restore) {
          // A partially replayed working file is never the serving path.
          // Retry may reuse it; publish only a complete, checkpointed image.
          db.exec("pragma wal_checkpoint(truncate); pragma journal_mode=delete;");
          db.close();
          linkSync(working, config.database); // Atomic and never overwrites.
          const directory = openSync(dirname(resolve(config.database)), "r");
          try { fsyncSync(directory); } finally { closeSync(directory); }
          unlinkSync(working);
          db = new DatabaseSync(config.database);
          db.exec("pragma journal_mode=wal; pragma synchronous=full; pragma foreign_keys=on;");
          return new DurableStore(db, journal, release, meta.store);
        }
        return store;
      } catch (error) {
        try { if (db?.isOpen) db.close(); } finally { release(); }
        throw error;
      }
    }), store => Effect.sync(() => store.close()));
  }
  private close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { this.release(); }
  }
  private saved(): Saved[] {
    return this.db.prepare("select seq,payload,acknowledged from outbox order by seq").all() as unknown as Saved[];
  }
  private put(value: Entry): void {
    const statement = this.db.prepare("insert into records values(?,?,?,?) on conflict(kind,key) " +
      "do update set value=excluded.value,seq=excluded.seq");
    for (const change of value.changes) statement.run(change.kind, change.key, JSON.stringify(change.value), value.seq);
  }
  private reconcile(history: readonly Entry[], restoring: boolean): void {
    const local = this.saved();
    if (restoring && local.length > history.length) throw Error("restore working file exceeds journal history");
    const decoded = local.map(row => decode(row.payload));
    let previous: Entry | undefined;
    let pending = false;
    for (let i = 0; i < Math.max(local.length, history.length); i++) {
      const row = local[i], remote = history[i], saved = decoded[i];
      const value = saved ?? remote;
      if (!value || value.seq !== i + 1 || value.store !== this.identity ||
          value.previous !== (previous?.hash ?? null) || (row && row.seq !== value.seq))
        throw Error("database/journal sequence or identity mismatch");
      if (row && row.acknowledged !== 0 && row.acknowledged !== 1) throw Error("invalid acknowledgment marker");
      if (row?.acknowledged === 0) pending = true;
      else if (row && pending) throw Error("database acknowledgments are not a prefix");
      if (saved && remote && saved.hash !== remote.hash) throw Error("database and journal disagree");
      if (!remote && row?.acknowledged === 1) throw Error("acknowledged history is missing from journal");
      previous = value;
    }
    // Replay into the projection atomically, including a journal ahead of a
    // coordinated SQLite snapshot. Retain pending local records for retry.
    this.db.exec("begin immediate");
    try {
      this.db.exec("delete from records");
      for (let i = 0; i < Math.max(local.length, history.length); i++) {
        const value = decoded[i] ?? history[i]!;
        this.db.prepare("insert into outbox values(?,?,?) on conflict(seq) do update set " +
          "acknowledged=excluded.acknowledged").run(value.seq, JSON.stringify(value), history[i] ? 1 : 0);
        this.put(value);
      }
      this.db.exec("commit");
    } catch (error) { this.db.exec("rollback"); throw error; }
  }
  private flushSync(): boolean {
    for (const row of this.db.prepare("select seq,payload,acknowledged from outbox " +
      "where acknowledged=0 order by seq").all() as unknown as Saved[]) {
      try {
        const publication: unknown = this.journal.append(decode(row.payload));
        if (publication !== undefined) {
          if (publication instanceof Promise) void publication.catch(() => {});
          throw Error("journal backend must acknowledge synchronously");
        }
      }
      catch (error) {
        this.journalFailure = error instanceof Error ? error.message : "journal unavailable";
        return false; // No acknowledgment; the outbox remains retryable.
      }
      this.db.prepare("update outbox set acknowledged=1 where seq=?").run(row.seq);
    }
    this.journalFailure = null;
    return true;
  }
  commit(changes: readonly Change[]): Effect.Effect<Receipt, StorageError> {
    return attempt("commit", () => {
      if (this.closed) throw Error("store is closed");
      validateChanges(changes);
      const last = this.db.prepare("select payload from outbox order by seq desc limit 1").get();
      const previous = last ? decode(last.payload as string) : undefined;
      const value = entry(this.identity, (previous?.seq ?? 0) + 1, previous?.hash ?? null, changes);
      this.db.exec("begin immediate");
      try {
        this.db.prepare("insert into outbox values(?,?,0)").run(value.seq, JSON.stringify(value));
        this.put(value);
        this.db.exec("commit");
      } catch (error) { this.db.exec("rollback"); throw error; }
      return { seq: value.seq, acknowledged: this.flushSync() };
    });
  }
  flush(): Effect.Effect<boolean, StorageError> { return attempt("flush", () => this.flushSync()); }
  /** Live proof for the application send gate, immediately before its RPC.
   * A historical SQLite acknowledgment alone is not an availability probe. */
  confirm(seq: number): Effect.Effect<boolean, StorageError> {
    return attempt("confirm", () => {
      if (!Number.isSafeInteger(seq) || seq < 1) return false;
      const row = this.db.prepare("select payload,acknowledged from outbox where seq=?").get(seq);
      if (!row || row.acknowledged !== 1) return false;
      const expected = decode(row.payload as string);
      try {
        const value = this.journal.read()[seq - 1];
        if (!value) throw Error("journal entry is not currently confirmed");
        const actual = decode(JSON.stringify(value));
        if (actual.seq !== seq || actual.hash !== expected.hash || actual.store !== this.identity)
          throw Error("live journal entry differs from acknowledged state");
        this.journalFailure = null;
        return true;
      } catch (error) {
        this.journalFailure = error instanceof Error ? error.message : "journal unavailable";
        return false;
      }
    });
  }
  get(kind: string, key: string): Effect.Effect<RecordValue | null, StorageError> {
    return attempt("get", () => {
      const row = this.db.prepare("select value,seq from records where kind=? and key=?").get(kind, key);
      if (!row) return null;
      const ack = this.db.prepare("select acknowledged from outbox where seq=?").get(row.seq!);
      return { value: JSON.parse(row.value as string) as Json, seq: row.seq as number,
        acknowledged: ack?.acknowledged === 1 };
    });
  }
  status() {
    return attempt("status", () => {
      const saved = this.saved();
      return { seq: saved.length, journalFailure: this.journalFailure, acknowledged: saved.filter(row => row.acknowledged === 1).length,
        restoreRequired: this.db.prepare("select restored from store_meta where id=1").get()?.restored === 1 };
    });
  }
}
