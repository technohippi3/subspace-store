import { closeSync, fsyncSync, linkSync, openSync, readFileSync, readdirSync,
  statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decode, type Entry } from "./codec.ts";

export interface Journal {
  read(): readonly Entry[];
  /** Return only after durable readback; an async adapter needs an async Effect flow. */
  append(entry: Entry): undefined;
}
function filename(seq: number): string { return String(seq).padStart(16, "0") + ".json"; }

/** One immutable object per transaction. link() publishes a complete fsynced
 * file without overwriting an earlier entry. Fsync of the directory and
 * exact readback precede acknowledgment. Directory is an existing dedicated
 * off-host mount/subdirectory, never silently created on startup. */
export class FileJournal implements Journal {
  readonly directory: string;
  private entries: Entry[];
  constructor(directory: string) {
    this.directory = directory;
    if (!statSync(directory).isDirectory()) throw Error("journal is not a directory");
    this.entries = this.scan();
  }
  private readEntry(seq: number): Entry {
    return decode(readFileSync(join(this.directory, filename(seq)), "utf8"));
  }
  private scan(): Entry[] {
    const files = readdirSync(this.directory).filter(name => !name.startsWith(".pending-"));
    if (files.some(name => !/^\d{16}\.json$/.test(name))) throw Error("unknown file in store journal");
    files.sort();
    const entries: Entry[] = [];
    for (const name of files) {
      const value = decode(readFileSync(join(this.directory, name), "utf8"));
      const previous = entries.at(-1);
      if (name !== filename(entries.length + 1) || value.seq !== entries.length + 1 ||
          value.previous !== (previous?.hash ?? null) || (previous && value.store !== previous.store))
        throw Error("journal sequence, identity or hash-chain mismatch");
      entries.push(value);
    }
    return entries;
  }
  read(): readonly Entry[] {
    const entries = this.scan();
    // A crashed append may have linked a fully fsynced file but not synced
    // its directory. Observation alone cannot acknowledge that publication.
    this.syncDirectory();
    // A backend instance may be reused after another owner has advanced the
    // journal. Adopt only after the same directory durability proof as readback.
    this.entries = entries;
    return entries;
  }
  append(value: Entry): undefined {
    // Check the full envelope even for alternate backend callers.
    const encoded = JSON.stringify(value);
    decode(encoded);
    const previous = this.entries.at(-1);
    if (value.seq <= this.entries.length) {
      const saved = this.readEntry(value.seq);
      if (saved.hash !== value.hash || saved.store !== value.store) throw Error("journal retry differs from saved entry");
      // A previous send may have published its file without acknowledging the
      // directory sync. Retry that durability boundary before returning.
      this.syncDirectory();
      return;
    }
    if (value.seq !== this.entries.length + 1 || value.previous !== (previous?.hash ?? null) ||
        (previous && value.store !== previous.store)) throw Error("journal append is not contiguous");
    if (previous && this.readEntry(previous.seq).hash !== previous.hash)
      throw Error("previous journal entry changed");
    const temporary = join(this.directory, ".pending-" + randomUUID());
    const destination = join(this.directory, filename(value.seq));
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, encoded + "\n", "utf8");
      fsyncSync(fd);
      try { linkSync(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const saved = this.readEntry(value.seq);
        if (saved.hash !== value.hash || saved.store !== value.store) throw Error("journal sequence already used");
      }
      this.syncDirectory();
      if (this.readEntry(value.seq).hash !== value.hash) throw Error("journal readback mismatch");
      this.entries.push(value);
    } finally { closeSync(fd); unlinkSync(temporary); }
  }
  private syncDirectory(): void {
    const fd = openSync(this.directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
