import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { verifiedSystemdCredential } from "./systemd-credential.ts";
import { Effect } from "effect";
import { ApplicationError } from "../application/records.ts";
import type { RuntimeConfig } from "./config.ts";

async function read(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 ||
        ((stat.mode & 0o077) !== 0 && !verifiedSystemdCredential(path, stat))) throw Error("invalid credential file");
    const value = (await file.readFile("utf8")).trim();
    if (!/^[\x21-\x7e]{32,256}$/.test(value)) throw Error("invalid credential");
    return value;
  } finally { await file.close(); }
}
/** Runtime-injected files, reread on every request. No generation or disk cache. */
export function credentials(config: RuntimeConfig["credentials"]) {
  const pair = Effect.tryPromise({ try: async () => {
    const [operator, subs] = await Promise.all([read(config.operator), read(config.subs)]);
    if (operator === subs) throw Error("role credentials must differ");
    return { operator, subs };
  }, catch: () => new ApplicationError({ code: "unavailable", message: "runtime credentials unavailable" }) });
  return { operator: pair.pipe(Effect.map(p => p.operator)), subs: pair.pipe(Effect.map(p => p.subs)) };
}
