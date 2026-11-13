import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Effect } from "effect";
import { BoundController } from "../../src/controller/issuance.ts";
import { FileControllerJournal, RemoteControllerJournal, latest } from "../../src/controller/journal.ts";
import { HttpRegistry } from "../../src/controller/registry-client.ts";
import { fixture } from "./application-fixture.ts";
import { credential } from "./entry-http-fixture.ts";
import { checkpoint, delegate, kernel, local, using } from "./controller-port-fixture.ts";

test("A24: TypeScript controller strictly rejects malformed, duplicate and mismatched entry receipts", async (t) => {
  const b = checkpoint({ entry_key: "1".repeat(32), delegate_in: delegate });
  const receipt = { found: true, entry: b.entry_key, root: b.root, oids: b.members, phase: "open", delegate: null, acknowledged: true, batchable: true };
  let raw = JSON.stringify(receipt), calls = 0;
  const server = createServer((request, response) => {
    calls++; assert.equal(request.url, "/operator/issuance-entries/lookup");
    assert.equal(request.headers.authorization, `Bearer ${credential}`); response.end(raw);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const address = server.address(); assert(address && typeof address !== "string");
  const registry = new HttpRegistry(`http://127.0.0.1:${address.port}`, Effect.succeed(credential));
  for (const bad of [{ ...receipt, entry: "2".repeat(32) }, { ...receipt, root: "b".repeat(64) },
    { ...receipt, oids: ["o1"] }, { ...receipt, oids: ["o2", "o1"] }, { ...receipt, acknowledged: 1 },
    { ...receipt, found: 1 }, { ...receipt, extra: true }, { ...receipt, phase: "closed" },
    { ...receipt, phase: "armed", delegate: "d".repeat(64) + ":4294967296" }, { found: false, extra: true }]) {
    raw = JSON.stringify(bad); await assert.rejects(Effect.runPromise(registry.lookup(b)), /controller/);
  }
  raw = JSON.stringify(receipt).replace('"found":true', '"found":true,"\\u0066ound":true');
  await assert.rejects(Effect.runPromise(registry.lookup(b)), /duplicate/);
  raw = JSON.stringify(receipt); assert.deepEqual(await Effect.runPromise(registry.lookup(b)), receipt);
  raw = '{"found":false}'; assert.deepEqual(await Effect.runPromise(registry.lookup(b)), { found: false });
  raw = '"' + "x".repeat(1024 * 1024) + '"';
  await assert.rejects(Effect.runPromise(registry.lookup(b)), /too large/);
  assert.equal(calls, 14);
  for (const origin of ["http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/path", "https://example.invalid/?q=1"])
    assert.throws(() => new HttpRegistry(origin, Effect.succeed(credential)), /origin/);
});

test("TypeScript controller consumes Python-produced SQLite/JSONL and Python reads its appended history", async (t) => {
  const f = fixture(t), k = kernel(f.root), row = checkpoint({ entry_key: "1".repeat(32) });
  // Build the handoff with the actual Python schema and Journal, including an opaque older event.
  const script = `import json,sqlite3,sys\nfrom controller.core import SCHEMA\nfrom controller.journal import Journal\nroot=sys.argv[1]\nb=json.loads(sys.argv[2])\nc=sqlite3.connect(root+'/controller.db')\nc.executescript(SCHEMA)\nc.execute('delete from batches')\nr=dict(b,members=json.dumps(b['members']))\nc.execute('insert into batches('+','.join(r)+') values('+','.join('?' for _ in r)+')',tuple(r.values()))\nc.commit();c.close()\nj=Journal(root+'/controller-journal','controller')\nj.path.write_text('')\nj.append('checkpoint',snapshot='mock-checkpoint')\nj.append('batch',batch=b)\n`;
  await promisify(execFile)("python3", ["-c", script, f.root, JSON.stringify(row)], { cwd: resolve("..") });
  // A fresh backend deliberately replaces the seed backend's pinned empty prefix.
  const { FileControllerJournal } = await import("../../src/controller/journal.ts");
  const journal = new FileControllerJournal(k.directory);
  await using({ ...k, config: { database: k.database, makeJournal: () => journal } }, controller => Effect.gen(function* () {
    assert.deepEqual(yield* controller.batch("b1"), row);
  }));
  journal.append({ ...row, state: "issuing", intent: 1, delegate_in: delegate, fee_rate: 1 });
  const result = await promisify(execFile)("python3", ["-c", "import json,sys;from controller.journal import Journal;print(json.dumps(Journal(sys.argv[1],'controller').entries()))", k.directory], { cwd: resolve("..") });
  const entries = JSON.parse(result.stdout) as { seq: number; kind: string; batch?: unknown }[];
  assert.equal(entries.length, 3); assert.equal(entries[0]!.kind, "checkpoint"); assert.equal(entries[2]!.seq, 3);
  assert.equal(latest(journal.entries()).get("b1")!.state, "issuing");
  const text = readFileSync(journal.path, "utf8"); writeFileSync(journal.path, text.replace("mock-checkpoint", "changed-checkpoint"));
  assert.throws(() => journal.entries(), /prefix changed/);
});

test("TypeScript controller remote journal preserves pending exact bytes and authenticates the full controller stream", () => {
  const objects: { sequence: number; sha256: string; data: string }[] = [];
  let lose = true, failRead = false;
  const command = { request<T>(request: object): T {
    const value = request as { op: string; stream: string; after?: number; sequence: number; sha256: string; data: string };
    assert.equal(value.stream, "controller");
    if (value.op === "journal-read") {
      if (failRead) throw Error("simulated outage");
      return { head: objects.length, entries: objects.slice(value.after) } as T;
    }
    assert.equal(value.op, "journal-append");
    const raw = Buffer.from(value.data, "base64"); assert.equal(createHash("sha256").update(raw).digest("hex"), value.sha256);
    const existing = objects[value.sequence - 1];
    if (existing) assert.deepEqual(existing, { sequence: value.sequence, sha256: value.sha256, data: value.data });
    else objects.push({ sequence: value.sequence, sha256: value.sha256, data: value.data });
    if (lose) { lose = false; throw Error("lost append reply"); }
    return { sequence: value.sequence, sha256: value.sha256 } as T;
  } };
  const journal = new RemoteControllerJournal(command), row = checkpoint();
  assert.throws(() => journal.append(row), /lost append reply/);
  assert.throws(() => journal.append({ ...row, entry_key: "1".repeat(32) }), /unresolved/);
  journal.append(row); assert.equal(objects.length, 1); assert.deepEqual(latest(journal.entries()).get("b1"), row);
  failRead = true; assert.throws(() => journal.entries(), /outage/); failRead = false;
  objects[0]!.sha256 = "0".repeat(64); assert.throws(() => journal.entries(), /digest/);
});

test("TypeScript controller lifetime ownership precedes schema and journal setup and startup failures release it", async (t) => {
  const f = fixture(t), k = kernel(f.root); let factories = 0;
  await using(k, () => Effect.promise(async () => {
    await assert.rejects(Effect.runPromise(Effect.scoped(BoundController.open({ database: k.database,
      makeJournal: () => { factories++; return k.journal; } }, k.ports))), /open unavailable/);
    assert.equal(factories, 0); assert.equal(local(k.database).state, "checkpointed");
  }));
  await assert.rejects(Effect.runPromise(Effect.scoped(BoundController.open({ database: k.database,
    makeJournal: () => { throw Error("simulated setup failure"); } }, k.ports))), /open unavailable/);
  await using(k, controller => controller.batch("b1"));
});

test("TypeScript controller refuses malformed JSON, invalid UTF-8 and malformed remote history before local mutation", async (t) => {
  for (const raw of [Buffer.from('{"seq":1,"kind":\n'), Buffer.concat([Buffer.from('{"seq":1,"kind":"checkpoint","note":"'),
    Buffer.from([0xff]), Buffer.from('"}\n')])]) {
    const f = fixture(t), k = kernel(f.root); writeFileSync(k.journal.path, raw);
    await assert.rejects(using({ ...k, config: { database: k.database, makeJournal: () => new FileControllerJournal(k.directory) } },
      controller => controller.batch("b1")), /malformed controller JSON|UTF-8/);
    assert.equal(local(k.database).state, "checkpointed");
  }
  for (const page of [null, { head: 1, entries: [null] }, { head: 1, entries: [{ sequence: 1, data: "/w==",
    sha256: createHash("sha256").update(Buffer.from([0xff])).digest("hex") }] }]) {
    const f = fixture(t), k = kernel(f.root);
    const journal = new RemoteControllerJournal({ request<T>(): T { return page as T; } });
    await assert.rejects(using({ ...k, config: { database: k.database, makeJournal: () => journal } },
      controller => controller.batch("b1")), /prefix|object|UTF-8/);
    assert.equal(local(k.database).state, "checkpointed");
  }
  const f = fixture(t), k = kernel(f.root);
  writeFileSync(k.journal.path, JSON.stringify({ seq: 1, kind: "batch", batch: checkpoint({ release_failed: "not-json" }) }) + "\n");
  await assert.rejects(using({ ...k, config: { database: k.database, makeJournal: () => new FileControllerJournal(k.directory) } },
    controller => controller.batch("b1")), /invalid controller release membership/);
});

test("TypeScript controller refuses unsupported schema objects and altered constraints before journal setup", async (t) => {
  for (const mutation of ["create view unknown_view as select * from batches",
    "create trigger unknown_trigger after insert on batches begin select 1; end",
    "create index unknown_index on batches(state)",
    "alter table batches add column unexpected text", "drop table alerts; create table alerts(n integer,kind text,bid text,detail text)"]) {
    const f = fixture(t), k = kernel(f.root), db = new DatabaseSync(k.database); db.exec(mutation); db.close();
    let factories = 0;
    await assert.rejects(using({ ...k, config: { database: k.database, makeJournal: () => { factories++; return k.journal; } } },
      controller => controller.batch("b1")), /unsupported controller/);
    assert.equal(factories, 0);
  }
});
