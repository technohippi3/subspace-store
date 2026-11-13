import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** Linux flock is attached to the open file description. The helper acquires
 * it through a duplicate of our descriptor; Node retains ownership after
 * the helper exits. No resident helper, PID file or stale-lock timeout. */
export function ownDatabase(database: string): () => void {
  if (process.platform !== "linux") throw Error("store ownership requires Linux flock");
  const path = resolve(database);
  const canonical = existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
  const fd = openSync(canonical + ".lock", "a+", 0o600);
  try {
    const result = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "pipe", "pipe", fd], timeout: 5_000,
    });
    if (result.error) throw Error("cannot acquire ownership: Linux flock is unavailable", { cause: result.error });
    if (result.status === 1) throw Error("store busy: another process owns the database");
    if (result.status !== 0) throw Error("cannot acquire store ownership");
  } catch (error) { closeSync(fd); throw error; }
  let closed = false;
  return () => { if (!closed) { closed = true; closeSync(fd); } };
}
