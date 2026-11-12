import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { ApplicationError } from "./records.ts";

export const CERTIFICATE_LIMIT = 1_048_576;
export const certificateHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Reconstructible bytes only. The journal holds their hash and binding.
 * The application owns this directory while holding its database lock. */
export class CertificateCache {
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory; mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  }
  put(bytes: Buffer) {
    const self = this;
    return Effect.try({ try: () => {
      const hash = certificateHash(bytes), temporary = join(self.directory, "." + randomUUID());
      try {
        writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        const file = openSync(temporary, "r"); try { fsyncSync(file); } finally { closeSync(file); }
        renameSync(temporary, join(self.directory, hash));
        const directory = openSync(self.directory, "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
      } finally { try { unlinkSync(temporary); } catch (e) { if (!e || typeof e !== "object" || !("code" in e) || e.code !== "ENOENT") throw e; } }
      return hash;
    }, catch: () => new ApplicationError({ code: "unavailable", message: "certificate cache write unavailable" }) });
  }
  get(hash: string, length: number) {
    const self = this;
    return Effect.try({ try: () => {
      try {
        if (length > CERTIFICATE_LIMIT || statSync(join(self.directory, hash)).size !== length) return null;
        const bytes = readFileSync(join(self.directory, hash));
        return bytes.length === length && certificateHash(bytes) === hash ? bytes : null;
      } catch (e) { if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return null; throw e; }
    }, catch: () => new ApplicationError({ code: "unavailable", message: "certificate cache read unavailable" }) });
  }
}
