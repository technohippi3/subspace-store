// Runs tools/ledger_vectors.py, which records the Python service ledger's
// own transitions, and returns them. Agreement with them is equivalence to
// the Python service: not a model result and not regtest evidence.
//
// SUBSPACE_VECTOR_SEEDS and SUBSPACE_VECTOR_STEPS lengthen the generated
// part. SUBSPACE_VECTOR_ROOT points at another checkout of the Python
// sources, for probing the replay with a deliberately changed ledger.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env["SUBSPACE_VECTOR_ROOT"]
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Recorded<V> {
  family: string;
  calls: number;
  unique: number;
  counts: Record<string, number>;
  conflicts: string[];
  policy: { hold_seconds: number; excess_minimum_over_fee: number };
  python_sources: { sha256: string; git_head: string | null;
                    changed_from_head: string[] | null };
  vectors: V[];
}

export function recordVectors<V>(family: "order" | "funds" | "incident" | "store"): Recorded<V> {
  const out = execFileSync("python3", [
    "tools/ledger_vectors.py", "--family", family,
    "--seeds", process.env["SUBSPACE_VECTOR_SEEDS"] ?? "8",
    "--steps", process.env["SUBSPACE_VECTOR_STEPS"] ?? "150",
  ], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 30 });
  return JSON.parse(out) as Recorded<V>;
}

export function describeSources(rec: Recorded<unknown>): string {
  const src = rec.python_sources;
  const at = src.git_head === null ? "outside a git checkout" : `at ${src.git_head.slice(0, 10)}`;
  return `python sources ${src.sha256.slice(0, 16)} ${at}`
    + (src.changed_from_head?.length ? `, changed: ${src.changed_from_head.join(", ")}` : "");
}

/** Collects the first few failures with their vector, and counts the rest. */
export class Failures {
  readonly shown: string[] = [];
  count = 0;

  add(what: string, vector: unknown): void {
    this.count++;
    if (this.shown.length < 5) this.shown.push(`${what}\n${JSON.stringify(vector)}`);
  }

  report(): string {
    return `${this.count} vectors disagree; the first:\n${this.shown.join("\n\n")}`;
  }
}
