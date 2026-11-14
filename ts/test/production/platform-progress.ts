import { openSync, closeSync, readSync, mkdirSync, writeFileSync, fstatSync, constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const phases = new Set<string>(JSON.parse(readFileSync(new URL("../../../deploy/systemd-fixture/progress-phases.json", import.meta.url), "utf8")));
const MAX_BYTES = 4 * 1024 * 1024, MAX_RECORDS = 16384;
interface Progress {
  version: 1; sequence: number; elapsedMs: number; event: "start" | "complete" | "error" | "state" | "limit"; phase: string;
}
function valid(value: unknown): value is Progress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join() === "elapsedMs,event,phase,sequence,version" && row.version === 1 &&
    Number.isSafeInteger(row.sequence) && (row.sequence as number) > 0 &&
    Number.isSafeInteger(row.elapsedMs) && (row.elapsedMs as number) >= 0 &&
    ["start", "complete", "error", "state", "limit"].includes(row.event as string) && phases.has(row.phase as string);
}
function collect(file: string) {
  let raw: Buffer;
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw Error("invalid progress object");
      raw = Buffer.alloc(MAX_BYTES + 1); let length = 0, count: number;
      while (length < raw.length && (count = readSync(fd, raw, length, raw.length - length, null)) !== 0) length += count;
      raw = raw.subarray(0, length);
    } finally { closeSync(fd); }
  } catch { return { source: "unavailable", discardedRecords: 0, events: [] as Progress[] }; }
  const events: Progress[] = []; let discardedRecords = 0, prior = 0, priorTime = 0;
  const bounded = raw.length > MAX_BYTES; raw = raw.subarray(0, MAX_BYTES);
  const lines = raw.toString("utf8").split("\n"); const partial = lines.pop() !== "";
  for (const line of lines.slice(0, MAX_RECORDS)) {
    let value: unknown; try { value = JSON.parse(line); } catch { discardedRecords++; continue; }
    if (!valid(value) || value.sequence <= prior || value.elapsedMs < priorTime) { discardedRecords++; continue; }
    events.push(value); prior = value.sequence; priorTime = value.elapsedMs;
  }
  return { source: bounded || lines.length > MAX_RECORDS || events.some(row => row.event === "limit") ? "bounded" : partial ? "partial" : "read",
    discardedRecords, events };
}

/** Retain only validated fixed-label data before the caller removes its temp
 * directory. Reporting errors cannot replace a primary fixture failure. */
export async function capturePlatformProgress<T>(work: () => Promise<T>, file: string, output?: string): Promise<T> {
  let failed = false;
  try { return await work(); }
  catch (error) { failed = true; throw error; }
  finally {
    try {
      const trace = collect(file);
      const normalExit = trace.events.some(row => row.event === "state" && row.phase === "diagnostics.finished");
      const report = { version: 1, outcome: failed ? "failure" : "success", normalExit, ...trace };
      if (output) {
        mkdirSync(output, { recursive: true, mode: 0o700 });
        writeFileSync(join(output, "platform-" + randomUUID() + ".json"), JSON.stringify(report) + "\n", { flag: "wx", mode: 0o600 });
      }
      if (failed) console.error("platform fixture progress", JSON.stringify({ outcome: report.outcome,
        source: trace.source, normalExit, discardedRecords: trace.discardedRecords, lastEvents: trace.events.slice(-12) }));
      if (!failed && (!normalExit || trace.source !== "read" || trace.discardedRecords))
        throw Error("successful platform fixture lacks complete valid progress");
    } catch (error) {
      if (!failed) throw error;
      console.error("platform fixture progress retention failed");
    }
  }
}
