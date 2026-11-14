import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EnvelopeFileJournal } from "../../src/storage/envelope-file-journal.ts";
import { encodeJournalEnvelope, ENVELOPE_MAX_BYTES, readJournalPayload } from "../../src/storage/journal-envelope.ts";

const vectors = JSON.parse(readFileSync(new URL("journal-envelope-vectors.json", import.meta.url), "utf8")) as {
  store: string; records: { name: string; payload: string }[] };
function vector(name: string): Buffer {
  const value = vectors.records.find(record => record.name === name); assert(value); return Buffer.from(value.payload);
}
const floor = vector("floor-first"), legacy = vector("legacy-compact");
const file = (directory: string, seq = 1) => join(directory, String(seq).padStart(16, "0") + ".json");
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "envelope-journal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "journal"); mkdirSync(directory); return { root, directory };
}
function successor(payload = floor) {
  const { entry } = readJournalPayload(payload);
  return encodeJournalEnvelope(vectors.store, entry.seq + 1, entry.hash, [{ kind: "data", key: "alpha", value: "saved" }]).bytes;
}
const moduleUrl = new URL("../../src/storage/envelope-file-journal.ts", import.meta.url).href;
// Faults wrap real synchronous filesystem calls in separate processes. No fake
// lock, virtual filesystem or production fault switch stands in for publication.
function child(directory: string, payload: Uint8Array, fault: string, mode = "append", competitor = Buffer.from("invalid competing payload")) {
  const script = `
    import fs from "node:fs";
    import {syncBuiltinESMExports} from "node:module";
    const [directory,payload,fault,mode,competitor] = process.argv.slice(1);
    const fsync = fs.fsyncSync, link = fs.linkSync;
    const events = [];
    fs.fsyncSync = fd => {
      const dir = fs.fstatSync(fd).isDirectory(); events.push(dir ? "directory-sync" : "file-sync");
      if (fault === (dir ? "directory-error" : "file-error")) throw Error("injected sync failure");
      if (dir && fault === "kill-before-directory") process.kill(process.pid,"SIGKILL");
      fsync(fd);
      if (dir && fault === "kill-after-directory") process.kill(process.pid,"SIGKILL");
    };
    fs.linkSync = (source,destination) => {
      events.push("link");
      if (fault === "kill-before-link") process.kill(process.pid,"SIGKILL");
      if (fault === "link-error") throw Error("injected link failure");
      if (fault === "same-existing") { link(source,destination); }
      if (fault === "different-existing") fs.writeFileSync(destination,Buffer.concat([Buffer.from(competitor,"base64"),Buffer.from("\\n")]));
      link(source,destination);
      if (fault === "kill-after-link") process.kill(process.pid,"SIGKILL");
      if (fault === "readback-error") fs.writeFileSync(destination,"invalid readback\\n");
    };
    syncBuiltinESMExports();
    const {EnvelopeFileJournal} = await import(${JSON.stringify(moduleUrl)});
    try {
      const journal = new EnvelopeFileJournal(directory);
      if (mode === "read") journal.read(); else journal.append(Buffer.from(payload,"base64"));
      events.push("returned"); console.log(JSON.stringify(events));
    } catch (error) { console.error(error.message); process.exitCode=1; }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script, directory,
    Buffer.from(payload).toString("base64"), fault, mode, competitor.toString("base64")], { encoding: "utf8", timeout: 10_000 });
}

test("file envelope journal publishes exact v2 bytes, retries and retains owned read views", t => {
  const { directory } = fixture(t), journal = new EnvelopeFileJournal(directory);
  assert.deepEqual(journal.read(), []);
  const input = Buffer.from(floor); journal.append(input); input.fill(0);
  assert.deepEqual(readFileSync(file(directory)), Buffer.concat([floor, Buffer.from("\n")]));
  assert.equal(statSync(file(directory)).mode & 0o777, 0o600);
  journal.append(floor); journal.append(successor());
  const records = journal.read(); assert.equal(records.length, 2);
  assert.equal(records[0]!.validation, "envelope-only"); assert(Object.isFrozen(records));
  records[0]!.bytes.fill(0); assert.deepEqual(journal.read()[0]!.bytes, Uint8Array.from(floor));
  assert.throws(() => { (records as unknown[]).pop(); });
  assert.deepEqual(readdirSync(directory), ["0000000000000001.json", "0000000000000002.json"]);
});

test("legacy file bytes survive reads, retries and floor migration without normalization", t => {
  for (const name of ["legacy-compact", "legacy-pretty", "legacy-duplicate-exponent"]) {
    const { directory } = fixture(t), payload = vector(name), physical = Buffer.concat([payload, Buffer.from("\n")]);
    writeFileSync(file(directory), physical);
    const journal = new EnvelopeFileJournal(directory);
    assert.equal(journal.read()[0]!.payload, payload.toString()); journal.append(payload);
    assert.deepEqual(readFileSync(file(directory)), physical);
    const changes = readJournalPayload(floor).entry.changes;
    journal.append(encodeJournalEnvelope(vectors.store, 2, readJournalPayload(payload).entry.hash, changes).bytes);
    assert.deepEqual(readFileSync(file(directory)), physical); assert.equal(journal.read().length, 2);
  }
  const { directory } = fixture(t); writeFileSync(file(directory), legacy);
  new EnvelopeFileJournal(directory).append(legacy); assert.deepEqual(readFileSync(file(directory)), legacy);
});

test("legacy same-hash alternate bytes refuse retries and retained-history rewrites", t => {
  const { directory } = fixture(t); writeFileSync(file(directory), legacy);
  const journal = new EnvelopeFileJournal(directory), pretty = vector("legacy-pretty");
  assert.equal(readJournalPayload(legacy).entry.hash, readJournalPayload(pretty).entry.hash);
  assert.throws(() => journal.append(pretty), /retry payload differs/);
  writeFileSync(file(directory), pretty);
  assert.throws(() => journal.read(), /retained journal payload changed/);
  assert.throws(() => journal.append(legacy), /retained journal payload changed/);
});

test("local structural prefix rejects invalid new histories before publication", t => {
  const { directory } = fixture(t), journal = new EnvelopeFileJournal(directory);
  assert.throws(() => journal.append(legacy), /new legacy/);
  assert.throws(() => journal.append(successor()), /lineage/);
  const ordinary = encodeJournalEnvelope(vectors.store, 1, null, [{ kind: "data", key: "alpha", value: 1 }]);
  assert.throws(() => journal.append(ordinary.bytes), /floor/); assert.deepEqual(readdirSync(directory), []);
  journal.append(floor);
  const repeated = encodeJournalEnvelope(vectors.store, 2, readJournalPayload(floor).entry.hash, readJournalPayload(floor).entry.changes);
  assert.throws(() => journal.append(repeated.bytes), /repeated/);
  const different = encodeJournalEnvelope("11111111-1111-1111-1111-111111111111", 2,
    readJournalPayload(floor).entry.hash, [{ kind: "data", key: "alpha", value: 1 }]);
  assert.throws(() => journal.append(different.bytes), /lineage/);
  assert.equal(readdirSync(directory).length, 1);
});

test("local scanner refuses gaps, malformed files, links, special files and oversized sparse files", t => {
  const { root, directory } = fixture(t);
  assert.throws(() => new EnvelopeFileJournal(join(root, "absent")));
  symlinkSync(directory, join(root, "alias")); assert.throws(() => new EnvelopeFileJournal(join(root, "alias")));
  for (const physical of [Buffer.from("bad\n"), floor, Buffer.concat([floor, Buffer.from("\n\n")])]) {
    writeFileSync(file(directory), physical); assert.throws(() => new EnvelopeFileJournal(directory));
  }
  unlinkSync(file(directory)); writeFileSync(file(directory, 2), floor);
  assert.throws(() => new EnvelopeFileJournal(directory), /filename sequence/); unlinkSync(file(directory, 2));
  writeFileSync(join(root, "outside"), Buffer.concat([floor, Buffer.from("\n")]));
  symlinkSync(join(root, "outside"), file(directory)); assert.throws(() => new EnvelopeFileJournal(directory)); unlinkSync(file(directory));
  assert.equal(spawnSync("mkfifo", [file(directory)]).status, 0);
  assert.throws(() => new EnvelopeFileJournal(directory), /invalid journal file/); unlinkSync(file(directory));
  writeFileSync(file(directory), ""); truncateSync(file(directory), ENVELOPE_MAX_BYTES + 2);
  assert.throws(() => new EnvelopeFileJournal(directory), /invalid journal file or size/); unlinkSync(file(directory));
  writeFileSync(join(directory, "unknown"), ""); assert.throws(() => new EnvelopeFileJournal(directory), /unknown file/);
});

test("retained prefix cannot disappear; valid externally advanced history is adopted durably", t => {
  const { directory } = fixture(t), first = new EnvelopeFileJournal(directory);
  first.append(floor); const second = new EnvelopeFileJournal(directory); second.append(successor());
  assert.equal(first.read().length, 2); unlinkSync(file(directory, 2));
  assert.throws(() => first.read(), /disappeared/);
});

test("real filesystem sync ordering precedes returns on publication, exact retry and recovery read", t => {
  const { directory } = fixture(t);
  const initial = child(directory, floor, "none"); assert.equal(initial.status, 0, initial.stderr);
  assert.deepEqual(JSON.parse(initial.stdout), ["file-sync", "link", "directory-sync", "returned"]);
  for (const mode of ["append", "read"]) {
    const retry = child(directory, floor, "none", mode); assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(JSON.parse(retry.stdout), mode === "append"
      ? ["file-sync", "file-sync", "directory-sync", "returned"] : ["file-sync", "directory-sync", "returned"]);
  }
});

test("new append syncs adopted prefix files before publishing and preserves earlier crash debris", t => {
  const { directory } = fixture(t), physical = Buffer.concat([floor, Buffer.from("\n")]);
  writeFileSync(file(directory), physical); // Deliberately no independent file fsync.
  const debris = join(directory, ".pending-prior-crash"); writeFileSync(debris, "unpublished evidence");
  const refused = child(directory, successor(), "file-error");
  assert.equal(refused.status, 1); assert.match(refused.stderr, /injected sync failure/);
  assert(!readdirSync(directory).includes("0000000000000002.json"));
  assert.deepEqual(readFileSync(file(directory)), physical);
  const appended = child(directory, successor(), "none"); assert.equal(appended.status, 0, appended.stderr);
  assert.deepEqual(JSON.parse(appended.stdout), ["file-sync", "file-sync", "link", "directory-sync", "returned"]);
  assert.equal(readFileSync(debris, "utf8"), "unpublished evidence");
  assert.equal(new EnvelopeFileJournal(directory).read().length, 2);
});

test("publication and recovery sync failures refuse success and retain exact retryable bytes", t => {
  for (const fault of ["file-error", "link-error", "directory-error"]) {
    const { directory } = fixture(t), failed = child(directory, floor, fault);
    assert.equal(failed.status, 1); assert.match(failed.stderr, /injected/);
    assert(!failed.stdout.includes("returned"));
    assert.deepEqual(readdirSync(directory), fault === "directory-error" ? ["0000000000000001.json"] : []);
    const retry = child(directory, floor, "none"); assert.equal(retry.status, 0, retry.stderr);
    for (const mode of ["append", "read"]) for (const retryFault of ["file-error", "directory-error"]) {
      const refused = child(directory, floor, retryFault, mode); assert.equal(refused.status, 1);
      assert.match(refused.stderr, /injected sync/); assert(!refused.stdout.includes("returned"));
    }
    assert.deepEqual(readFileSync(file(directory)), Buffer.concat([floor, Buffer.from("\n")]));
  }
});

test("SIGKILL before and after immutable publication leaves only recoverable exact payloads", t => {
  for (const fault of ["kill-before-link", "kill-after-link", "kill-before-directory", "kill-after-directory"]) {
    const { directory } = fixture(t), killed = child(directory, floor, fault);
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    const finalFiles = readdirSync(directory).filter(name => !name.startsWith(".pending-"));
    assert.equal(finalFiles.length, fault === "kill-before-link" ? 0 : 1);
    const retry = child(directory, floor, "none"); assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(new EnvelopeFileJournal(directory).read()[0]!.bytes, Uint8Array.from(floor));
    assert.deepEqual(readFileSync(file(directory)), Buffer.concat([floor, Buffer.from("\n")]));
  }
});

test("non-overwrite collision compares bytes and corrupt readback cannot return success", t => {
  for (const fault of ["same-existing", "different-existing", "readback-error"]) {
    const { directory } = fixture(t), result = child(directory, floor, fault);
    if (fault === "same-existing") {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ["file-sync", "link", "file-sync", "directory-sync", "returned"]);
    } else {
      assert.equal(result.status, 1); assert(!result.stdout.includes("returned"));
      assert.match(readFileSync(file(directory), "utf8"), /^invalid/);
    }
    assert(!readdirSync(directory).some(name => name.startsWith(".pending-")));
  }
  const { directory } = fixture(t), change = readJournalPayload(floor).entry.changes[0]!;
  const alternative = encodeJournalEnvelope(vectors.store, 1, null, [{ ...change,
    value: { ...(change.value as Record<string, unknown>), capabilityDigest: "1".repeat(64) } }]).bytes;
  const conflict = child(directory, floor, "different-existing", "append", Buffer.from(alternative));
  assert.equal(conflict.status, 1); assert.match(conflict.stderr, /sequence already used/);
  assert.deepEqual(readFileSync(file(directory)), Buffer.concat([alternative, Buffer.from("\n")]));
});
