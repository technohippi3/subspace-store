import { closeSync, lstatSync, fstatSync, openSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
/** Call before storage/journal initialization; keep the returned closure in the runtime scope. */
export function ownInstallation(path: string, latch: string) {
  const latched = () => lstatSync(latch, { throwIfNoEntry: false }) !== undefined;
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


import { dirname, join } from "node:path";
import { Effect } from "effect";
import { ApplicationError } from "../application/records.ts";
/** The package creates the protected file; runtimes never create or unlink it. */
export function ownConfiguredInstallation(path?: string) {
  return Effect.acquireRelease(Effect.try({try: () => path ? ownInstallation(path, join(dirname(path), "maintenance.json")) : () => {},
    catch: () => new ApplicationError({code:"unavailable",message:"installation maintenance is active or ownership unavailable"})}),
    release => Effect.sync(release));
}
