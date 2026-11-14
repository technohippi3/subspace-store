import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EnvelopeOutbox } from "../../src/storage/envelope-outbox.ts";
import { encodeJournalEnvelope, ENVELOPE_MAX_BYTES, readJournalPayload } from "../../src/storage/journal-envelope.ts";
import type { Change } from "../../src/storage/codec.ts";

const vectors = JSON.parse(readFileSync(new URL("journal-envelope-vectors.json", import.meta.url), "utf8")) as {
  store: string; records: { name: string; payload: string; embeddedHash: string; recordDigest: string }[] };
function vector(name: string): Buffer {
  const value = vectors.records.find(record => record.name === name); assert(value); return Buffer.from(value.payload);
}
const floor = vector("floor-first"), second = vector("successor-after-floor"), legacy = vector("legacy-compact");
const schema = "create table outbox(seq INTEGER PRIMARY KEY,payload TEXT NOT NULL,acknowledged INTEGER NOT NULL)";
function open(path: string, create = false, mode = "wal") {
  const db = new DatabaseSync(path); db.exec(`pragma journal_mode=${mode}; pragma synchronous=FULL`);
  if (create) db.exec(schema); return db;
}
function fixture(t: TestContext, mode = "wal") {
  const root = mkdtempSync(join(tmpdir(), "envelope-outbox-")), path = join(root, "outbox.sqlite");
  const db = open(path, true, mode);
  t.after(() => { if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, db, outbox: new EnvelopeOutbox(db, vectors.store) };
}
function raw(db: DatabaseSync) {
  return db.prepare("select seq,cast(payload as blob) as bytes,acknowledged from outbox order by seq").all();
}
function seed(db: DatabaseSync, seq: number, payload: string | Uint8Array, acknowledged = 0) {
  db.prepare("insert into outbox values(?,?,?)").run(seq, payload, acknowledged);
}
function next(payload: Uint8Array, changes: readonly Change[]) {
  const { entry } = readJournalPayload(payload);
  return encodeJournalEnvelope(vectors.store, entry.seq + 1, entry.hash, changes).bytes;
}

test("outbox preserves independent legacy bytes including whitespace, duplicates, exponents and LF across reopen", t => {
  for (const name of ["legacy-compact", "legacy-pretty", "legacy-duplicate-exponent"]) {
    const { db, path, outbox } = fixture(t), payload = Buffer.concat([vector(name), Buffer.from("\n")]);
    assert.throws(() => outbox.append(payload), /new legacy/); assert.deepEqual(raw(db), []);
    outbox.reconcile([payload]); outbox.append(payload);
    assert.deepEqual(raw(db)[0]!.bytes, Uint8Array.from(payload)); assert.equal(raw(db)[0]!.acknowledged, 1);
    db.close(); const reopened = open(path);
    try {
      const retained = new EnvelopeOutbox(reopened, vectors.store); assert.equal(retained.read()[0]!.record.payload, payload.toString());
      assert.deepEqual(retained.read()[0]!.record.bytes, Uint8Array.from(payload)); retained.append(payload);
      retained.append(next(payload, readJournalPayload(floor).entry.changes));
      assert.deepEqual(raw(reopened)[0]!.bytes, Uint8Array.from(payload));
    } finally { reopened.close(); }
  }
});

test("outbox local append retains exact owned v2 views and retry markers in WAL and DELETE modes", t => {
  for (const mode of ["wal", "delete"]) {
    const { db, outbox } = fixture(t, mode), input = Buffer.from(floor);
    assert.deepEqual(outbox.read(), []); outbox.append(input); input.fill(0); outbox.append(second);
    const before = raw(db); outbox.append(floor); outbox.append(second); assert.deepEqual(raw(db), before);
    const rows = outbox.read(); assert(Object.isFrozen(rows)); assert(Object.isFrozen(rows[0]));
    rows[0]!.record.bytes.fill(0); assert.deepEqual(outbox.pending()[0]!.bytes, Uint8Array.from(floor));
    assert.throws(() => { (rows as unknown[]).pop(); });
    assert.throws(() => { (rows[1]!.record.entry.changes[0]!.value as { items: number[] }).items.push(4); });
    outbox.reconcile([floor]); outbox.append(floor); assert.equal(outbox.read()[0]!.historicalAcknowledged, true);
    assert.equal(rows[0]!.historicalAcknowledged, false); assert.equal(outbox.pending().length, 1);
  }
});

test("outbox reconciliation advances only markers, imports exact bytes and preserves pending tails", t => {
  const { db, outbox } = fixture(t); outbox.append(floor); outbox.append(second);
  const third = next(second, [{ kind: "data", key: "alpha", value: false }]); outbox.append(third);
  outbox.reconcile([floor]); assert.deepEqual(outbox.pending().map(row => row.entry.seq), [2, 3]);
  outbox.reconcile([floor, second]); assert.deepEqual(raw(db).map(row => row.acknowledged), [1, 1, 0]);
  const before = raw(db); assert.throws(() => outbox.reconcile([floor]), /historically acknowledged/);
  assert.deepEqual(raw(db), before);
  const fourth = next(third, [{ kind: "data", key: "other", value: 0 }]);
  outbox.reconcile([floor, second, third, fourth]); assert.deepEqual(outbox.pending(), []);
  assert.deepEqual(raw(db).map(row => row.bytes), [floor, second, third, fourth].map(payload => Uint8Array.from(payload)));
});

test("outbox same-logical-hash alternate bytes refuse reconcile and retry without rewriting", t => {
  const { db, outbox } = fixture(t), alternate = vector("legacy-pretty"); seed(db, 1, legacy.toString());
  assert.equal(readJournalPayload(legacy).entry.hash, readJournalPayload(alternate).entry.hash);
  const before = raw(db); assert.throws(() => outbox.append(alternate), /retry bytes/);
  assert.throws(() => outbox.reconcile([alternate]), /observed bytes disagree/); assert.deepEqual(raw(db), before);
  outbox.reconcile([legacy]); assert.deepEqual(raw(db)[0]!.bytes, Uint8Array.from(legacy));
});

test("outbox rejects invalid prospective lineage, store identity, floor and framed LF before mutation", t => {
  const { db, outbox } = fixture(t);
  const ordinary = encodeJournalEnvelope(vectors.store, 1, null, [{ kind: "data", key: "alpha", value: 1 }]).bytes;
  const foreign = encodeJournalEnvelope("11111111-1111-1111-1111-111111111111", 1, null, readJournalPayload(floor).entry.changes).bytes;
  for (const payload of [second, ordinary, foreign, Buffer.concat([floor, Buffer.from("\n")])]) {
    assert.throws(() => outbox.append(payload)); assert.deepEqual(raw(db), []);
    assert.throws(() => outbox.reconcile([payload])); assert.deepEqual(raw(db), []);
  }
  outbox.append(floor); const before = raw(db);
  assert.throws(() => outbox.append(next(floor, readJournalPayload(floor).entry.changes)), /repeated/);
  assert.deepEqual(raw(db), before);
});

test("outbox codec-derived lookup distinguishes pending and historical false, zero, null, array and object values", t => {
  const { db, outbox } = fixture(t); outbox.append(floor);
  const values = [false, 0, null, [3, 2, 1], { a: 1, b: false }];
  const data = next(floor, values.map((value, i) => ({ kind: "data", key: String(i), value })));
  outbox.append(data); outbox.reconcile([floor, data]);
  const pending = next(data, [{ kind: "data", key: "0", value: "pending" }]); outbox.append(pending);
  for (const [i, value] of values.entries()) assert.deepEqual(outbox.lookup("data", String(i), true)?.change.value, value);
  assert.equal(outbox.lookup("data", "0")?.change.value, "pending");
  assert.equal(outbox.lookup("data", "0")?.historicalAcknowledged, false);
  assert.equal(outbox.lookup("missing", "0"), null); assert.equal(outbox.lookup("data", "missing"), null);
  assert.throws(() => db.prepare("select value from outbox,json_each(outbox.payload,'$.changes')").all(), /malformed JSON/);
  const golden = vectors.records.find(row => row.name === "floor-first")!;
  const { outbox: first } = fixture(t); first.append(floor);
  assert.deepEqual(first.head(), { validation: "envelope-only", store: vectors.store, sequence: 1,
    hash: golden.embeddedHash, recordDigest: golden.recordDigest, historicalAcknowledgedHead: 0 });
  assert.equal(outbox.head().historicalAcknowledgedHead, 2); assert.equal(outbox.head().sequence, 3);
});

test("outbox scanner rejects malformed SQLite row types, UTF-8, sequence, identity and marker history", t => {
  const invalid: ((db: DatabaseSync) => void)[] = [
    db => seed(db, 2, floor.toString()), db => seed(db, 1, floor), db => seed(db, 1, "invalid"),
    db => seed(db, 1, floor.toString(), 2),
    db => db.exec("insert into outbox values(1,cast(x'ff' as text),0)"),
    db => { seed(db, 1, floor.toString()); seed(db, 2, second.toString(), 1); },
    db => seed(db, 1, second.toString()),
    db => seed(db, 1, floor.toString().replace(vectors.store, "11111111-1111-1111-1111-111111111111")),
    db => db.prepare("insert into outbox values(1,cast(zeroblob(?) as text),0)").run(ENVELOPE_MAX_BYTES + 1),
  ];
  for (const write of invalid) {
    const { db, outbox } = fixture(t); write(db); assert.throws(() => outbox.read());
    assert.equal(db.isTransaction, false); assert.throws(() => outbox.append(floor));
  }
});

test("outbox refuses unsafe profiles, foreign schemas, attached and temporary databases", t => {
  const memory = new DatabaseSync(":memory:"); memory.exec(schema);
  try { assert.throws(() => new EnvelopeOutbox(memory, vectors.store), /profile/); } finally { memory.close(); }
  const changes = ["pragma synchronous=OFF", "pragma journal_mode=OFF", "create table store_meta(version INTEGER)",
    "create table sqliteX(value TEXT)", "alter table outbox add column extra TEXT generated always as (payload)",
    "create view other as select * from outbox", "create temp table scratch(value TEXT)", "attach ':memory:' as other"];
  for (const change of changes) {
    const { db, outbox } = fixture(t);
    if (change === "pragma journal_mode=OFF") db.enableDefensive(false);
    db.exec(change);
    if (change === "pragma journal_mode=OFF") assert.equal(db.prepare("pragma journal_mode").get()?.journal_mode, "off");
    assert.throws(() => outbox.append(floor));
    assert.equal(db.prepare("select count(*) as n from main.outbox").get()?.n, 0);
  }
  const temporary = open("", true, "delete");
  try { assert.throws(() => new EnvelopeOutbox(temporary, vectors.store), /temporary/); } finally { temporary.close(); }
  const { root } = fixture(t), utf16 = new DatabaseSync(join(root, "utf16.sqlite"));
  try {
    utf16.exec(`pragma encoding='UTF-16le'; pragma journal_mode=delete; pragma synchronous=FULL; ${schema}`);
    assert.throws(() => new EnvelopeOutbox(utf16, vectors.store), /profile/);
  } finally { utf16.close(); }
  const { db } = fixture(t); db.exec("drop table outbox; create table outbox(seq INTEGER PRIMARY KEY,payload TEXT,acknowledged INTEGER)");
  assert.throws(() => new EnvelopeOutbox(db, vectors.store), /table shape/);
  assert.throws(() => new EnvelopeOutbox(db, "invalid"), /identity/);
});

test("outbox refuses caller transactions without committing or rolling back their staged work", t => {
  const { db, outbox } = fixture(t); db.exec("begin immediate"); seed(db, 1, floor.toString());
  for (const attempt of [() => outbox.read(), () => outbox.append(floor), () => outbox.reconcile([floor])])
    assert.throws(attempt, /caller transactions/);
  assert.equal(db.isTransaction, true); assert.equal(raw(db).length, 1); db.exec("rollback"); assert.deepEqual(raw(db), []);
});

test("outbox SQL failure during remote-ahead import atomically rolls back inserted rows and markers", t => {
  const { db, outbox } = fixture(t); outbox.append(floor); const before = raw(db);
  db.exec("create trigger stop_insert before insert on outbox when new.seq=2 begin select raise(abort,'injected insert failure'); end");
  assert.throws(() => outbox.reconcile([floor, second]), /injected insert failure/);
  assert.deepEqual(raw(db), before); assert.equal(db.isTransaction, false);
  db.exec("drop trigger stop_insert"); outbox.reconcile([floor, second]); assert.deepEqual(outbox.pending(), []);
});

test("outbox failed DELETE-mode commit rolls back without acknowledging or losing the exact request", t => {
  const { db, path, outbox } = fixture(t, "delete"); outbox.append(floor); const before = raw(db);
  // A separate read transaction deliberately blocks the real SQLite commit.
  // This is lock-error injection, not an ownership/concurrency qualification.
  const reader = open(path, false, "delete");
  try {
    reader.exec("begin"); reader.prepare("select * from outbox").all();
    assert.throws(() => outbox.reconcile([floor, second]), /locked/);
    assert.equal(db.isTransaction, false); assert.deepEqual(raw(db), before);
    reader.exec("rollback"); outbox.reconcile([floor, second]); assert.deepEqual(outbox.pending(), []);
  } finally { reader.close(); }
});

test("outbox readback rejects trigger rewrites, deleted rows and changed markers with full rollback", t => {
  for (const body of ["update outbox set payload=payload||' ' where seq=new.seq;", "delete from outbox where seq=new.seq;",
    "update outbox set acknowledged=0 where seq=new.seq;"]) {
    const { db, outbox } = fixture(t); seed(db, 1, legacy.toString()); const before = raw(db);
    db.exec(`create trigger disturb after update on outbox begin ${body} end`);
    assert.throws(() => outbox.reconcile([legacy]), /readback|sequence|retained/);
    assert.deepEqual(raw(db), before); assert.equal(db.isTransaction, false);
  }
});

test("outbox retained history refuses byte substitution, truncation and historical-marker regression", t => {
  for (const change of ["update outbox set payload=payload||' '", "delete from outbox", "update outbox set acknowledged=0"]) {
    const { db, outbox } = fixture(t); outbox.reconcile([legacy]); const saved = outbox.read(); db.exec(change);
    assert.throws(() => outbox.read(), /retained/); assert.equal(saved[0]!.historicalAcknowledged, true);
    assert.deepEqual(saved[0]!.record.bytes, Uint8Array.from(legacy));
  }
});

test("outbox WAL backup and reopen retain exact original bytes, lookups and historical marker head", async t => {
  const { db, root, outbox } = fixture(t); const old = vector("legacy-duplicate-exponent"), migrated = vector("floor-after-legacy");
  outbox.reconcile([old, migrated]); outbox.append(vector("successor-after-legacy-floor"));
  const path = join(root, "backup.sqlite"); await backup(db, path);
  const snapshot = open(path);
  try {
    const restored = new EnvelopeOutbox(snapshot, vectors.store); assert.deepEqual(raw(snapshot), raw(db));
    assert.deepEqual(restored.head(), outbox.head()); assert.deepEqual(restored.lookup("data", "alpha"), outbox.lookup("data", "alpha"));
    assert.deepEqual(restored.pending().map(row => row.bytes), outbox.pending().map(row => row.bytes));
  } finally { snapshot.close(); }
});

test("outbox real child SIGKILL before commit rolls back the whole import, after commit retains it", t => {
  const { path, db, outbox } = fixture(t); outbox.append(floor); const before = raw(db); db.close();
  const moduleUrl = new URL("../../src/storage/envelope-outbox.ts", import.meta.url).href;
  const script = `
    import {DatabaseSync} from 'node:sqlite';
    import {EnvelopeOutbox} from ${JSON.stringify(moduleUrl)};
    const [path,store,first,second,fault]=process.argv.slice(1);
    const db=new DatabaseSync(path); db.exec('pragma synchronous=FULL');
    if(fault==='before') {
      db.function('terminate',()=>{process.kill(process.pid,'SIGKILL');return 0;});
      db.exec('create trigger terminate_insert after insert on outbox begin select terminate(); end');
    }
    new EnvelopeOutbox(db,store).reconcile([Buffer.from(first,'base64'),Buffer.from(second,'base64')]);
    process.kill(process.pid,'SIGKILL');
  `;
  for (const fault of ["before", "after"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, path, vectors.store,
      floor.toString("base64"), second.toString("base64"), fault], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined); assert.equal(result.signal, "SIGKILL", result.stderr);
    const reopened = open(path);
    try {
      if (fault === "before") { assert.deepEqual(raw(reopened), before); reopened.exec("drop trigger terminate_insert"); }
      else {
        const recovered = new EnvelopeOutbox(reopened, vectors.store);
        assert.equal(recovered.read().length, 2); assert.deepEqual(recovered.pending(), []);
        assert.deepEqual(raw(reopened).map(row => row.bytes), [floor, second].map(payload => Uint8Array.from(payload)));
      }
    } finally { reopened.close(); }
  }
});
