import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readdirSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ENVELOPE_MAX_BYTES, ENVELOPE_MAX_HEAD, inspectEnvelopePrefix, journalFileBytes,
  readJournalFile, readJournalPayload, type EnvelopeRecord } from "./journal-envelope.ts";

const filename = (seq: number) => String(seq).padStart(16, "0") + ".json";
const equal = (a: EnvelopeRecord, b: EnvelopeRecord) => Buffer.from(a.bytes).equals(b.bytes);

/** Dormant local byte-storage boundary. The caller must hold exclusive ownership
 * and protect the directory for this object's entire lifetime. Structural file
 * durability is not domain validation, off-host acknowledgment or effect permission.
 * This does not implement the currently selected Journal interface. */
export class EnvelopeFileJournal {
  readonly directory: string;
  private records: readonly EnvelopeRecord[];
  constructor(directory: string) {
    this.directory = resolve(directory);
    if (!lstatSync(this.directory).isDirectory()) throw Error("journal requires an existing directory");
    this.records = this.scan();
  }
  private readFile(seq: number, sync = false): EnvelopeRecord {
    const fd = openSync(join(this.directory, filename(seq)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > ENVELOPE_MAX_BYTES + 1)
        throw Error("invalid journal file or size");
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0, count: number;
      while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) !== 0) size += count;
      if (size !== stat.size) throw Error("journal file size changed");
      const record = readJournalFile(bytes.subarray(0, size));
      if (sync) fsyncSync(fd);
      return record;
    } finally { closeSync(fd); }
  }
  private scan(sync = false): readonly EnvelopeRecord[] {
    const files = readdirSync(this.directory).filter(name => !name.startsWith(".pending-"));
    if (files.length > ENVELOPE_MAX_HEAD || files.some(name => !/^\d{16}\.json$/.test(name)))
      throw Error("unknown file or excessive journal head");
    files.sort();
    const records: EnvelopeRecord[] = [];
    const self = this;
    function* payloads() {
      for (const [index, name] of files.entries()) {
        if (name !== filename(index + 1)) throw Error("journal filename sequence mismatch");
        const record = self.readFile(index + 1, sync);
        records.push(record);
        yield record.bytes;
      }
    }
    inspectEnvelopePrefix(payloads());
    return Object.freeze(records);
  }
  private retained(next: readonly EnvelopeRecord[]): void {
    if (next.length < this.records.length || this.records.some((record, index) => !equal(record, next[index]!)))
      throw Error("retained journal payload changed or disappeared");
  }
  private syncDirectory(): void {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  read(): readonly EnvelopeRecord[] {
    const next = this.scan(true);
    this.retained(next);
    this.syncDirectory();
    this.records = next;
    return next;
  }
  /** Input is the exact payload P, never a decoded Entry or a physical file.
   * New writes require v2. Existing v1 retries compare P without rewriting files. */
  append(payload: Uint8Array): undefined {
    const record = readJournalPayload(payload);
    // A visible prefix may have been copied or linked without durable file
    // contents. Sync every adopted file before publishing its successor.
    const current = this.scan(true);
    this.retained(current);
    if (record.entry.seq <= current.length) {
      if (!equal(record, current[record.entry.seq - 1]!)) throw Error("journal retry payload differs");
      const durable = this.read();
      if (!equal(record, durable[record.entry.seq - 1]!)) throw Error("journal retry readback mismatch");
      return;
    }
    if (record.entry.version !== 2) throw Error("new legacy journal writes are unsupported");
    inspectEnvelopePrefix((function* () { for (const saved of current) yield saved.bytes; yield record.bytes; })());
    const temporary = join(this.directory, ".pending-" + randomUUID());
    const destination = join(this.directory, filename(record.entry.seq));
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, journalFileBytes(record));
      fsyncSync(fd);
      try { linkSync(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!equal(record, this.readFile(record.entry.seq, true))) throw Error("journal sequence already used");
      }
      this.syncDirectory();
      const next = this.scan();
      this.retained(next);
      if (next.length !== current.length + 1 || current.some((saved, index) => !equal(saved, next[index]!)) ||
          !equal(record, next.at(-1)!)) throw Error("journal publication readback mismatch");
      this.records = next;
    } finally { closeSync(fd); unlinkSync(temporary); }
  }
}
