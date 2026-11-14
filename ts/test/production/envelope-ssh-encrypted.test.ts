import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { EnvelopeSshJournal } from "../../src/storage/envelope-ssh-journal.ts";
import { readJournalPayload, encodeJournalEnvelope } from "../../src/storage/journal-envelope.ts";
import { encryptedFixture } from "./envelope-ssh-fixture.ts";

test("dormant envelope adapter uses real pinned encrypted SSH for exact legacy/v2 retries, chunking, conflicts and outage", { timeout: 180_000 }, async t => {
  const fixture = JSON.parse(readFileSync(new URL("journal-envelope-vectors.json", import.meta.url), "utf8")) as {
    store: string; records: { name: string; payload: string }[] };
  const vector = (name: string) => { const value = fixture.records.find(v => v.name === name); assert(value); return Buffer.from(value.payload); };
  const f = await encryptedFixture(t), raw = Buffer.concat([vector("legacy-pretty"), Buffer.from("\n")]);
  const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
  // Existing history is seeded through the unchanged opaque encrypted client.
  f.command.request({ op: "journal-append", stream: "store", sequence: 1, sha256: digest(raw), data: raw.toString("base64") });
  const journal = new EnvelopeSshJournal(f.command); assert.equal(journal.read()[0]!.payload, raw.toString());
  const originalCiphertext = f.encrypted(1); assert(!originalCiphertext.includes(raw));
  journal.append(raw); assert.deepEqual(f.encrypted(1), originalCiphertext);
  assert.throws(() => journal.append(raw.subarray(0, -1)), /retry bytes differ/);
  const floor = encodeJournalEnvelope(fixture.store, 2, readJournalPayload(raw).entry.hash, readJournalPayload(vector("floor-first")).entry.changes);
  journal.append(floor.bytes);
  const large = encodeJournalEnvelope(fixture.store, 3, floor.entry.hash, [{ kind: "data", key: "chunked", value: "x".repeat(1024 * 1024) }]);
  journal.append(large.bytes); journal.append(large.bytes); journal.append(raw);
  const records = journal.read(); assert.equal(records.length, 3);
  assert.deepEqual(records[1]!.bytes, floor.bytes); assert.deepEqual(records[2]!.bytes, large.bytes);
  assert(!f.encrypted(3).includes(Buffer.from("x".repeat(4096))));
  assert.throws(() => f.command.request({ op: "journal-append", stream: "store", sequence: 1,
    sha256: digest(raw.subarray(0, -1)), data: raw.subarray(0, -1).toString("base64") }), /unavailable/);
  assert.deepEqual(f.encrypted(1), originalCiphertext); assert.deepEqual(journal.read()[0]!.bytes, Uint8Array.from(raw));
  assert.throws(() => new EnvelopeSshJournal(f.wrongCommand).read(), /unavailable/);
  assert.equal(journal.read().length, 3);
  f.stop(); assert.throws(() => journal.read(), /unavailable/); assert.throws(() => journal.append(raw), /unavailable/);
});
