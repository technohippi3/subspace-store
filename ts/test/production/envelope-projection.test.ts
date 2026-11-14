import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EnvelopeOutbox, EnvelopeProjectionStore } from "../../src/storage/envelope-outbox.ts";
import { encodeJournalEnvelope, readJournalPayload } from "../../src/storage/journal-envelope.ts";
import { entry, type Change } from "../../src/storage/codec.ts";

const vectors = JSON.parse(readFileSync(new URL("journal-envelope-vectors.json", import.meta.url), "utf8")) as {
  store: string; records: { name: string; payload: string }[] };
function vector(name: string): Buffer {
  const row = vectors.records.find(row => row.name === name); assert(row); return Buffer.from(row.payload);
}
const floor = vector("floor-first"), second = vector("successor-after-floor");
const schema = "create table outbox(seq INTEGER PRIMARY KEY,payload TEXT NOT NULL,acknowledged INTEGER NOT NULL);" +
  "create table records(kind TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,seq INTEGER NOT NULL,primary key(kind,key))";
function open(path: string, create = false, mode = "wal") {
  const db = new DatabaseSync(path); db.exec(`pragma journal_mode=${mode}; pragma synchronous=FULL`);
  if (create) db.exec(schema); return db;
}
function fixture(t: TestContext, mode = "wal") {
  const root = mkdtempSync(join(tmpdir(), "envelope-projection-")), path = join(root, "store.sqlite"), db = open(path, true, mode);
  t.after(() => { if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, db, store: new EnvelopeProjectionStore(db, vectors.store) };
}
function saved(db: DatabaseSync) {
  return {
    outbox: db.prepare("select seq,cast(payload as blob) as bytes,acknowledged from outbox order by seq").all(),
    records: db.prepare("select cast(kind as blob) as kind,cast(key as blob) as key,cast(value as blob) as value,seq from records order by rowid").all(),
  };
}
function next(payload: Uint8Array, changes: readonly Change[]) {
  const { entry } = readJournalPayload(payload);
  return encodeJournalEnvelope(vectors.store, entry.seq + 1, entry.hash, changes).bytes;
}

test("projection profile atomically derives latest values and owned immutable snapshots in WAL and DELETE", t => {
  for (const mode of ["wal", "delete"]) {
    const { db, store } = fixture(t, mode); assert.deepEqual(store.projected(), []);
    store.append(floor); store.append(second);
    const value = store.get("data", "alpha")!;
    assert.deepEqual(value, { validation: "envelope-projection-only", kind: "data", key: "alpha",
      value: { "2": "two", "10": "ten", items: [3, 2, 1] }, seq: 2, historicalAcknowledged: false });
    assert.equal(db.prepare("select value from records where kind='data'").get()?.value, '{"2":"two","10":"ten","items":[3,2,1]}');
    assert(Object.isFrozen(store.projected())); assert(Object.isFrozen(value));
    assert.throws(() => { (value.value as { items: number[] }).items.push(4); });
    const before = saved(db); store.append(second); assert.deepEqual(saved(db), before);
    store.reconcile([floor, second]); assert.equal(store.get("data", "alpha")!.historicalAcknowledged, true);
    assert.equal(value.historicalAcknowledged, false); assert.equal(store.get("missing", "key"), null);
    assert.deepEqual(saved(db).outbox.map(row => row.bytes), [floor, second].map(p => Uint8Array.from(p)));
  }
});

test("projection preserves original legacy bytes and derived property order through floor append and reopen", t => {
  for (const name of ["legacy-compact", "legacy-pretty", "legacy-duplicate-exponent"]) {
    const { db, path, store } = fixture(t), payload = Buffer.concat([vector(name), Buffer.from("\n")]);
    store.reconcile([payload]); store.append(payload);
    assert.equal(db.prepare("select value from records").get()?.value, '{"b":2,"a":1}');
    store.append(vector("floor-after-legacy")); store.append(vector("successor-after-legacy-floor"));
    assert.deepEqual(saved(db).outbox[0]!.bytes, Uint8Array.from(payload)); db.close();
    const reopened = open(path);
    try {
      const restored = new EnvelopeProjectionStore(reopened, vectors.store);
      assert.equal(restored.read().length, 3); assert.equal(restored.get("data", "alpha")!.seq, 3);
      assert.equal(restored.get("data", "alpha")!.historicalAcknowledged, false);
      assert.deepEqual(saved(reopened).outbox[0]!.bytes, Uint8Array.from(payload));
    } finally { reopened.close(); }
  }
});

test("projection marker-only reconciliation and exact retry never rewrite record rows or pending values", t => {
  const { db, store } = fixture(t); store.append(floor); store.append(second);
  const third = next(second, [{ kind: "data", key: "alpha", value: "pending latest" }]); store.append(third);
  const rows = saved(db).records;
  db.exec("create trigger no_projection_update before update on records begin select raise(abort,'unexpected projection rewrite'); end;" +
    "create trigger no_projection_insert before insert on records begin select raise(abort,'unexpected projection insert'); end");
  store.append(second); store.reconcile([floor, second]);
  assert.deepEqual(saved(db).records, rows); assert.equal(store.get("data", "alpha")!.value, "pending latest");
  assert.equal(store.get("data", "alpha")!.seq, 3); assert.equal(store.get("data", "alpha")!.historicalAcknowledged, false);
  assert.deepEqual(store.pending().map(row => row.entry.seq), [3]);
  assert.throws(() => store.reconcile([floor]), /historically acknowledged/); assert.deepEqual(saved(db).records, rows);
});

test("projection legacy value serialization preserves escaped characters and expands only the derived number text", t => {
  const { db, store } = fixture(t);
  const original = JSON.stringify(entry(vectors.store, 1, null, [
    { kind: "data", key: "number", value: 1e20 }, { kind: "data", key: "character", value: "\ud800" },
  ]));
  const payload = Buffer.from(original.replace("100000000000000000000", "1e20"));
  assert.notEqual(payload.toString(), original); store.reconcile([payload]);
  assert.equal(db.prepare("select value from records where key='number'").get()?.value, "100000000000000000000");
  assert.equal(db.prepare("select value from records where key='character'").get()?.value, '"\\ud800"');
  assert.equal(store.get("data", "character")!.value, "\ud800");
  assert.deepEqual(saved(db).outbox[0]!.bytes, Uint8Array.from(payload));
});

test("projection snapshots freeze a bounded large flat JSON array without spread argument limits", t => {
  const { store } = fixture(t); store.append(floor);
  store.append(next(floor, [{ kind: "data", key: "array", value: Array<number>(200_000).fill(0) }]));
  const value = store.get("data", "array")!.value as number[];
  assert.equal(value.length, 200_000); assert.equal(value[0], 0); assert.equal(value.at(-1), 0);
  assert(Object.isFrozen(value)); assert.throws(() => value.push(1));
});

test("projection reads follow the existing JSON roundtrip for legacy negative zero while history retains original bytes", t => {
  const { db, store } = fixture(t);
  const plain = JSON.stringify(entry(vectors.store, 1, null, [
    { kind: "data", key: "zero", value: 0 }, { kind: "data", key: "nested", value: { zero: 0, items: [0] } },
  ]));
  const payload = Buffer.from(plain.replace('"value":0', '"value":-0').replace('"zero":0', '"zero":-0').replace('"items":[0]', '"items":[-0]'));
  assert(Object.is(readJournalPayload(payload).entry.changes[0]!.value, -0)); store.reconcile([payload]);
  assert.equal(db.prepare("select value from records where key='zero'").get()?.value, "0");
  assert(Object.is(store.get("data", "zero")!.value, 0));
  const nested = store.get("data", "nested")!.value as { zero: number; items: number[] };
  assert(Object.is(nested.zero, 0)); assert(Object.is(nested.items[0], 0)); assert(Object.isFrozen(nested.items));
  assert(Object.is(store.lookup("data", "zero")!.change.value, -0));
  assert.deepEqual(saved(db).outbox[0]!.bytes, Uint8Array.from(payload));
});

test("projection retains false zero null arrays objects and exact Unicode identities without treating null as deletion", t => {
  const { db, store } = fixture(t); store.append(floor);
  const values = [false, 0, null, [3, 2, 1], { b: false, a: "value" }];
  const changes = values.map((value, i) => ({ kind: "data", key: "\ufeff😀\u0000" + i, value }));
  store.append(next(floor, changes));
  for (const change of changes) assert.deepEqual(store.get(change.kind, change.key)!.value, change.value);
  assert.equal(db.prepare("select count(*) as n from records").get()?.n, 6);
  store.append(next(store.read().at(-1)!.record.bytes, [{ kind: "data", key: changes[0]!.key, value: null }]));
  assert.equal(store.get("data", changes[0]!.key)!.value, null); assert.equal(store.get("data", changes[0]!.key)!.seq, 3);
});

test("projection local SQL failure rolls back exact outbox and all earlier record changes before retry", t => {
  const { db, store } = fixture(t); store.append(floor); const before = saved(db);
  const payload = next(floor, [{ kind: "data", key: "first", value: 1 }, { kind: "data", key: "second", value: 2 }]);
  db.exec("create trigger fail_second before insert on records when new.key='second' begin select raise(abort,'injected projection failure'); end");
  assert.throws(() => store.append(payload), /injected projection failure/);
  assert.deepEqual(saved(db), before); assert.equal(db.isTransaction, false);
  db.exec("drop trigger fail_second"); store.append(payload); assert.equal(store.head().sequence, 2);
  assert.equal(store.get("data", "first")!.value, 1); assert.equal(store.get("data", "second")!.value, 2);
});

test("projection remote-ahead SQL failure rolls back both imported payloads and existing acknowledgment markers", t => {
  const { db, store } = fixture(t); store.append(floor); const before = saved(db);
  db.exec("create trigger fail_data before insert on records when new.kind='data' begin select raise(abort,'injected import failure'); end");
  assert.throws(() => store.reconcile([floor, second]), /injected import failure/);
  assert.deepEqual(saved(db), before); assert.equal(store.pending().length, 1);
  db.exec("drop trigger fail_data"); store.reconcile([floor, second]);
  assert.equal(store.get("data", "alpha")!.historicalAcknowledged, true); assert.deepEqual(store.pending(), []);
});

test("projection refuses at-rest corruption without rebuilding it or changing the outbox", t => {
  for (const sql of ["delete from records where kind='data'", "update records set seq=1 where kind='data'",
    "update records set value=value||' ' where kind='data'", "update records set value=cast(value as blob) where kind='data'",
    "update records set value=cast(zeroblob(100000) as text) where kind='data'",
    "update records set key=cast(x'ff' as text) where kind='data'", "update records set kind=cast(kind as blob) where kind='data'",
    "insert into records values('data','foreign','null',2)"]) {
    const { db, store } = fixture(t); store.reconcile([floor, second]); db.exec(sql); const corrupt = saved(db);
    for (const attempt of [() => store.get("data", "alpha"), () => store.append(second), () => store.reconcile([floor, second]),
      () => new EnvelopeProjectionStore(db, vectors.store).projected()]) assert.throws(attempt);
    assert.deepEqual(saved(db), corrupt); assert.equal(db.isTransaction, false);
  }
});

test("projection final readback rejects trigger changes in either table and rolls back the pair", t => {
  for (const trigger of [
    "create trigger disturb after insert on outbox when new.seq=2 begin insert into records values('data','foreign','null',2); end",
    "create trigger disturb after insert on records when new.kind='data' begin update records set value=value||' ' where kind='store_protocol'; end",
    "create trigger disturb after insert on records when new.kind='data' begin update outbox set acknowledged=1; end",
    "create trigger disturb after insert on records when new.kind='data' begin update outbox set payload=payload||' ' where seq=1; end",
  ]) {
    const { db, store } = fixture(t); store.append(floor); const before = saved(db); db.exec(trigger);
    assert.throws(() => store.append(second)); assert.deepEqual(saved(db), before); assert.equal(db.isTransaction, false);
  }
});

test("projection fixed profile refuses serving schemas hidden columns unknown tables and caller transactions", t => {
  const { db, store } = fixture(t);
  assert.throws(() => new EnvelopeOutbox(db, vectors.store), /outbox-only/);
  const extra = EnvelopeOutbox as unknown as new (db: DatabaseSync, store: string, flag: boolean) => EnvelopeOutbox;
  assert.throws(() => new extra(db, vectors.store, true), /outbox-only/);
  db.exec("begin immediate"); db.prepare("insert into outbox values(1,?,0)").run(floor.toString());
  assert.throws(() => store.append(floor), /caller transactions/); assert.throws(() => store.projected(), /caller transactions/);
  assert.equal(db.isTransaction, true); db.exec("rollback"); assert.deepEqual(saved(db).outbox, []);
  for (const sql of ["create table store_meta(version INTEGER)", "create table sqliteX(value TEXT)",
    "create view other as select * from records", "alter table records add column extra TEXT generated always as (value)",
    "create temp table scratch(value TEXT)", "attach ':memory:' as other",
    "drop table records; create table records(kind TEXT COLLATE NOCASE NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,seq INTEGER NOT NULL,primary key(kind,key))",
    "drop table records; create table records(kind TEXT NOT NULL,key TEXT COLLATE RTRIM NOT NULL,value TEXT NOT NULL,seq INTEGER NOT NULL,primary key(kind,key))",
    "drop table records; create table records(kind TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,seq INTEGER NOT NULL,primary key(kind,key)) without rowid"]) {
    const { db } = fixture(t); db.exec(sql); assert.throws(() => new EnvelopeProjectionStore(db, vectors.store));
  }
});

test("projection refuses unrepresentable legacy keys and differing same-hash histories without lossy import", t => {
  const { db, store } = fixture(t);
  const lossy = Buffer.from(JSON.stringify(entry(vectors.store, 1, null, [{ kind: "data", key: "\ud800", value: "kept" }])));
  assert.equal(readJournalPayload(lossy).entry.changes[0]!.key, "\ud800");
  assert.throws(() => store.reconcile([lossy]), /losslessly/); assert.deepEqual(saved(db).outbox, []); assert.deepEqual(saved(db).records, []);
  store.reconcile([vector("legacy-compact")]); const before = saved(db);
  assert.throws(() => store.reconcile([vector("legacy-pretty")]), /bytes disagree/); assert.deepEqual(saved(db), before);
});

test("projection busy DELETE-mode commit rolls back both tables and exact retry succeeds", t => {
  const { db, path, store } = fixture(t, "delete"); store.append(floor); const before = saved(db), reader = open(path, false, "delete");
  try {
    reader.exec("begin"); reader.prepare("select * from records").all();
    assert.throws(() => store.reconcile([floor, second]), /locked/); assert.deepEqual(saved(db), before); assert.equal(db.isTransaction, false);
    reader.exec("rollback"); store.reconcile([floor, second]); assert.equal(store.get("data", "alpha")!.seq, 2);
  } finally { reader.close(); }
});

test("projection WAL backup reopens exact payloads and complete matching latest rows", async t => {
  const { db, root, store } = fixture(t); store.reconcile([vector("legacy-duplicate-exponent"), vector("floor-after-legacy")]);
  store.append(vector("successor-after-legacy-floor")); const path = join(root, "backup.sqlite"); await backup(db, path);
  const copy = open(path);
  try {
    const reopened = new EnvelopeProjectionStore(copy, vectors.store); assert.deepEqual(saved(copy), saved(db));
    assert.deepEqual(reopened.projected(), store.projected()); assert.deepEqual(reopened.head(), store.head());
  } finally { copy.close(); }
});

test("projection real SIGKILL during record writes preserves the old pair and postcommit kill preserves the new pair", t => {
  for (const mode of ["wal", "delete"]) {
    const { db, path, store } = fixture(t, mode); store.append(floor); const before = saved(db); db.close();
    const url = new URL("../../src/storage/envelope-outbox.ts", import.meta.url).href;
    const script = `
      import {DatabaseSync} from 'node:sqlite'; import {EnvelopeProjectionStore} from ${JSON.stringify(url)};
      const [path,store,first,second,fault]=process.argv.slice(1);const db=new DatabaseSync(path);db.exec('pragma synchronous=FULL');
      if(fault==='before') {db.function('terminate',()=>{process.kill(process.pid,'SIGKILL');return 0;});
        db.exec("create trigger terminate_projection after insert on records when new.kind='data' begin select terminate(); end");}
      new EnvelopeProjectionStore(db,store).reconcile([Buffer.from(first,'base64'),Buffer.from(second,'base64')]);
      process.kill(process.pid,'SIGKILL');
    `;
    for (const fault of ["before", "after"]) {
      const killed = spawnSync(process.execPath, ["--input-type=module", "-e", script, path, vectors.store,
        floor.toString("base64"), second.toString("base64"), fault], { encoding: "utf8", timeout: 10_000 });
      assert.equal(killed.error, undefined); assert.equal(killed.signal, "SIGKILL", killed.stderr);
      const reopened = open(path, false, mode);
      try {
        if (fault === "before") { assert.deepEqual(saved(reopened), before); reopened.exec("drop trigger terminate_projection"); }
        else {
          const recovered = new EnvelopeProjectionStore(reopened, vectors.store);
          assert.equal(recovered.read().length, 2); assert.equal(recovered.get("data", "alpha")!.seq, 2);
          assert.equal(recovered.get("data", "alpha")!.historicalAcknowledged, true); assert.deepEqual(recovered.pending(), []);
          assert.deepEqual(saved(reopened).outbox.map(row => row.bytes), [floor, second].map(p => Uint8Array.from(p)));
        }
      } finally { reopened.close(); }
    }
  }
});
