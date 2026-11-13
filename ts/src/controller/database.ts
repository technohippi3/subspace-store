import { DatabaseSync } from "node:sqlite";
import { ownDatabase } from "../storage/ownership.ts";
import { batch, possibleSend, type Batch } from "./records.ts";
import { refuse } from "./errors.ts";

const schema = `create table if not exists batches (
  bid text primary key, space text not null, members text not null,
  digest text not null, state text not null, prior_root text, root text,
  delegate_in text, fee_rate integer, txid text, mined_height integer,
  intent integer not null default 0, attempted integer not null default 0,
  supersedes text, answer text, raw text, recovery_paused integer not null default 0,
  ancestors text, entry_key text, release_failed text);
create table if not exists alerts (n integer primary key, kind text, bid text, detail text);
create table if not exists recoveries (
  n integer primary key, snapshot text, restored_at real not null, subs_at real,
  replayed_at real, reconciled_at real, ready_at real);`;
const migrations: Record<string, Record<string, string>> = {
  batches: { ancestors: "text", entry_key: "text", release_failed: "text" },
  recoveries: { snapshot: "text", subs_at: "real", replayed_at: "real", reconciled_at: "real", ready_at: "real" },
};
function definitions(sql: string): string[] {
  const normalized = sql.toLowerCase().replaceAll(/\s+/g, "").replace("createtableifnotexists", "createtable");
  const match = /^createtable[a-z]+\((.*)\);?$/.exec(normalized);
  if (!match) refuse("unsupported controller table definition", "invalid");
  return match[1]!.split(",").sort();
}
function admit(db: DatabaseSync): void {
  const objects = db.prepare("select type,name,tbl_name,sql from sqlite_master").all();
  const tables = objects.filter(row => row.type === "table");
  if (tables.length && tables.map(row => row.name).sort().join() !== "alerts,batches,recoveries")
    refuse("unsupported controller database; explicit reconciliation required");
  for (const row of objects) {
    if (row.type === "index" && row.name === "sqlite_autoindex_batches_1" && row.tbl_name === "batches" && row.sql === null) continue;
    if (row.type !== "table") refuse("unsupported controller database object", "invalid");
    const name = String(row.name), expected = schema.match(new RegExp(`create table if not exists ${name} \\([\\s\\S]*?\\);`))?.[0];
    if (!expected || typeof row.sql !== "string") refuse("unsupported controller table", "invalid");
    const columns = db.prepare(`pragma table_info(${name})`).all().map(column => String(column.name));
    const optional = new Set(Object.keys(migrations[name] ?? {}));
    const wanted = definitions(expected).filter(field => {
      const key = [...optional].find(key => field === key + "text" || field === key + "real");
      return !key || columns.includes(key);
    });
    if (definitions(row.sql).join() !== wanted.join()) refuse("unsupported controller table definition", "invalid");
  }
}
export class BatchDatabase {
  private readonly db: DatabaseSync;
  private readonly release: () => void;
  private closed = false;
  constructor(path: string) {
    const release = ownDatabase(path); let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      admit(db);
      db.exec("pragma synchronous=FULL"); db.exec(schema);
      for (const [table, fields] of Object.entries(migrations)) {
        const have = db.prepare(`pragma table_info(${table})`).all().map(row => row.name);
        for (const [name, type] of Object.entries(fields)) if (!have.includes(name)) db.exec(`alter table ${table} add column ${name} ${type}`);
      }
      this.db = db; this.release = release;
      this.batches();
    } catch (error) { db?.close(); release(); throw error; }
  }
  private active(): void { if (this.closed) refuse("controller is closed"); }
  close(): void { if (!this.closed) { this.closed = true; try { this.db.close(); } finally { this.release(); } } }
  get(bid: string): Batch {
    this.active(); const row = this.db.prepare("select * from batches where bid=?").get(bid);
    if (!row) refuse("no such controller batch");
    return batch({ ...row, members: JSON.parse(String(row.members)) });
  }
  batches(): Batch[] {
    this.active(); return this.db.prepare("select bid from batches order by rowid").all().map(row => this.get(String(row.bid)));
  }
  patch(bid: string, fields: Partial<Omit<Batch, "bid">>): Batch {
    const next = batch({ ...this.get(bid), ...fields });
    const row = { ...next, members: JSON.stringify(next.members) }, keys = Object.keys(row).filter(key => key !== "bid") as (keyof typeof row)[];
    this.db.prepare(`update batches set ${keys.map(key => `${key}=?`).join(",")} where bid=?`).run(...keys.map(key => row[key]), bid);
    return this.get(bid);
  }
  private transaction(work: () => void): void {
    this.active(); this.db.exec("begin immediate");
    try { work(); this.db.exec("commit"); } catch (error) { this.db.exec("rollback"); throw error; }
  }
  freeze(space: string, members: readonly string[], digest: string, priorRoot: string | null): Batch {
    let bid = "";
    this.transaction(() => {
      const all = this.batches(), closed = ["rebuilt", "final", "fulfilled", "superseded"];
      if (all.some(b => b.space === space && !closed.includes(b.state)) || all.some(b => !closed.includes(b.state) && b.members.some(id => members.includes(id))))
        refuse("another batch is open or a preparation member is busy");
      bid = `b${all.length + 1}`;
      const value = batch({ bid, space, members: [...members], digest, state: "frozen", prior_root: priorRoot, root: null,
        delegate_in: null, fee_rate: null, txid: null, mined_height: null, intent: 0, attempted: 0, supersedes: null,
        answer: null, raw: null, recovery_paused: 0, ancestors: null, entry_key: null, release_failed: null });
      const row = { ...value, members: JSON.stringify(value.members) }, keys = Object.keys(row) as (keyof typeof row)[];
      this.db.prepare(`insert into batches(${keys.join(",")}) values(${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key]));
    });
    return this.get(bid);
  }
  completeRebuild(bid: string, failed: readonly string[], digest: string, paused: boolean): string | null {
    let child: string | null = null;
    this.transaction(() => {
      const parent = this.get(bid), all = this.batches(), keep = parent.members.filter(id => !failed.includes(id));
      if (possibleSend(parent) || parent.state === "rebuilt" || all.some(b => b.supersedes === bid))
        refuse("controller parent cannot retire again or after a possible send");
      if (parent.release_failed !== null && (JSON.parse(parent.release_failed) as string[]).some(id => !failed.includes(id)))
        refuse("controller failed members cannot shrink during retirement");
      if (keep.length && !paused) {
        child = `b${all.length + 1}`;
        const value = batch({ ...parent, bid: child, members: keep, digest, state: "frozen", prior_root: parent.prior_root,
          root: null, delegate_in: null, fee_rate: null, txid: null, mined_height: null, intent: 0, attempted: 0,
          supersedes: bid, answer: null, raw: null, recovery_paused: 0, ancestors: null, entry_key: null, release_failed: null });
        const row = { ...value, members: JSON.stringify(value.members) }, keys = Object.keys(row) as (keyof typeof row)[];
        this.db.prepare(`insert into batches(${keys.join(",")}) values(${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key]));
      } else if (!keep.length) this.db.prepare("insert into alerts(kind,bid,detail) values('every_member_failed',?,'')").run(bid);
      if (paused && !this.db.prepare("select n from alerts where kind='rebuilds' and bid=?").get(bid))
        this.db.prepare("insert into alerts(kind,bid,detail) values('rebuilds',?,'paused until next block')").run(bid);
      this.patch(bid, { state: "rebuilt", intent: 0, release_failed: JSON.stringify(failed) });
    });
    return child;
  }
  uncertain(bid: string, answer: string, why: string, armedDelegate?: string): Batch {
    this.transaction(() => {
      this.patch(bid, { state: "broadcast_uncertain", attempted: 1, answer,
        ...(armedDelegate === undefined ? {} : { intent: 1, delegate_in: armedDelegate }) });
      this.db.prepare("insert into alerts(kind,bid,detail) values('broadcast_uncertain',?,?)").run(bid, why);
    }); return this.get(bid);
  }
  adopt(value: Batch): void {
    const next = batch(value), row = { ...next, members: JSON.stringify(next.members) }, keys = Object.keys(row) as (keyof typeof row)[];
    this.transaction(() => {
      this.db.prepare("delete from batches where bid=?").run(next.bid);
      this.db.prepare(`insert into batches(${keys.join(",")}) values(${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key]));
      this.db.prepare("insert into alerts(kind,bid,detail) values('database_behind_journal',?,?)").run(next.bid, `held here as an older state; took the journal's ${next.state}`);
    });
  }
  requireRestored(journalBids: ReadonlySet<string>): void {
    this.active(); const local = new Set(this.batches().map(b => b.bid));
    const pending = this.db.prepare("select ready_at from recoveries order by n desc limit 1").get();
    if ([...journalBids].some(id => !local.has(id)) || pending?.ready_at === null)
      refuse("controller restore required; this slice cannot reconcile host history", "restore_required");
  }
  alerts() { this.active(); return this.db.prepare("select kind,bid,detail from alerts order by n").all(); }
}
