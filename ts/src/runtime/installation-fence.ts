import { closeSync, lstatSync, fstatSync, openSync, readSync, realpathSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const applicationPath = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
function recoveryAllowed(marker: string): boolean {
  const fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
        ![0, process.geteuid!()].includes(info.uid) || info.size > 65_536) return false;
    const bytes = Buffer.alloc(65_537), size = readSync(fd, bytes);
    if (size > 65_536) return false;
    const value: unknown = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    const named = lstatSync(marker);
    return named.dev === info.dev && named.ino === info.ino && !!value && typeof value === "object" &&
      !Array.isArray(value) && (value as {version?:unknown}).version === 1 &&
      (value as {applicationPath?:unknown}).applicationPath === applicationPath;
  } finally { closeSync(fd); }
}
/** Call before storage/journal initialization; keep the returned closure in the runtime scope. */
export function ownInstallation(path: string, latch: string, purpose: "ordinary" | "recovery" = "ordinary") {
  const marker = join(dirname(path), "recovery.json");
  const latched = () => lstatSync(latch, { throwIfNoEntry: false }) !== undefined ||
    lstatSync(marker, { throwIfNoEntry: false }) !== undefined && (purpose !== "recovery" || !recoveryAllowed(marker));
  if (latched()) throw Error('installation maintenance is active');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o022) !== 0 || ![0, process.geteuid!()].includes(info.uid)) throw Error('invalid installation ownership file');
    const child = spawnSync('/usr/bin/flock', ['--shared', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 5000 });
    const named = lstatSync(path);
    if (child.error || child.status !== 0 || named.dev !== info.dev || named.ino !== info.ino || latched()) throw Error('installation maintenance is active');
  } catch (error) { closeSync(fd); throw error; }
  let closed = false;
  return () => { if (!closed) { closed = true; closeSync(fd); } };
}


import { Effect } from "effect";
import { ApplicationError } from "../application/records.ts";
/** The package creates the protected file; runtimes never create or unlink it. */
export function ownConfiguredInstallation(path?: string, purpose: "ordinary" | "recovery" = "ordinary") {
  return Effect.acquireRelease(Effect.try({try: () => path ? ownInstallation(path, join(dirname(path), "maintenance.json"), purpose) : () => {},
    catch: () => new ApplicationError({code:"unavailable",message:"installation maintenance is active or ownership unavailable"})}),
    release => Effect.sync(release));
}
