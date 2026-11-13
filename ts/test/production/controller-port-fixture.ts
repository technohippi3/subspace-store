import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, type Scope } from "effect";
import { BatchDatabase } from "../../src/controller/database.ts";
import { BoundController, type ControllerConfig } from "../../src/controller/issuance.ts";
import { FileControllerJournal } from "../../src/controller/journal.ts";
import { ControllerError } from "../../src/controller/errors.ts";
import { HttpRegistry } from "../../src/controller/registry-client.ts";
import type { Batch } from "../../src/controller/records.ts";
import type { BroadcastAnswer, ControllerPorts } from "../../src/controller/ports.ts";
import { credential } from "./entry-http-fixture.ts";

export const delegate = "d".repeat(64) + ":0";
export const txid = "f".repeat(64);
export function checkpoint(fields: Partial<Batch> = {}): Batch {
  return { bid: "b1", space: "@space", members: ["o1", "o2"], digest: "mock-checkpoint-digest", state: "checkpointed",
    prior_root: null, root: "a".repeat(64), delegate_in: null, fee_rate: null, txid: null, mined_height: null,
    intent: 0, attempted: 0, supersedes: null, answer: null, raw: null, recovery_paused: 0,
    ancestors: null, entry_key: null, release_failed: null, ...fields };
}
export function put(database: string, value: Batch): void {
  const db = new DatabaseSync(database);
  const row = { ...value, members: JSON.stringify(value.members) }, keys = Object.keys(row) as (keyof typeof row)[];
  try {
    db.prepare(`insert or replace into batches(${keys.join(",")}) values(${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key]));
  } finally { db.close(); }
}
export function local(database: string): Batch {
  const db = new DatabaseSync(database, { readOnly: true });
  try { const row = db.prepare("select * from batches where bid='b1'").get()!;
    return { ...row, members: JSON.parse(String(row.members)) } as unknown as Batch;
  } finally { db.close(); }
}
export class FaultJournal extends FileControllerJournal {
  down = false;
  afterAppend: ((value: Batch) => void) | undefined;
  override entries() {
    if (this.down) throw new ControllerError({ code: "unavailable", message: "simulated controller journal outage" });
    return super.entries();
  }
  override append(value: Batch): void { super.append(value); this.afterAppend?.(value); }
}
export function kernel(root: string, origin = "http://127.0.0.1:1") {
  const database = join(root, "controller.db"), directory = join(root, "controller-journal"); mkdirSync(directory);
  new BatchDatabase(database).close(); put(database, checkpoint());
  const journal = new FaultJournal(directory); journal.append(checkpoint());
  const calls = { broadcasts: 0, captures: 0, answer: { status: 200, body: JSON.stringify({ txid }) } as BroadcastAnswer,
    broadcastError: false, beforeArm: undefined as (() => void) | undefined, afterArm: undefined as (() => void) | undefined };
  const registry = new HttpRegistry(origin, Effect.succeed(credential));
  const ports: ControllerPorts = {
    registry: { failing: (b, issuing) => registry.failing(b, issuing), lookup: b => registry.lookup(b), enter: b => registry.enter(b),
      close: b => registry.close(b), order: (b, id) => registry.order(b, id),
      arm: b => Effect.gen(function* () { calls.beforeArm?.(); const answer = yield* registry.arm(b); calls.afterArm?.(); return answer; }) },
    height: () => Effect.succeed(10), delegate: () => Effect.succeed(delegate), broadcast: () => Effect.gen(function* () {
      calls.broadcasts++; if (calls.broadcastError) return yield* Effect.fail(new ControllerError({ code: "unavailable", message: "simulated lost broadcast response" }));
      return calls.answer;
    }), capture: () => Effect.sync(() => { calls.captures++; return { txid, raw: "010203", ancestors: [["e".repeat(64), "040506"]] }; }),
  };
  const config: ControllerConfig = { database, makeJournal: () => journal };
  return { database, directory, journal, config, ports, calls };
}
export type Kernel = ReturnType<typeof kernel>;
export function using<A, E>(f: Kernel, work: (controller: BoundController) => Effect.Effect<A, E, Scope.Scope>) {
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const controller = yield* BoundController.open(f.config, f.ports); return yield* work(controller);
  })));
}
export function sends(root: string): number {
  try { return readFileSync(join(root, "controller-sends.jsonl"), "utf8").trim().split("\n").filter(Boolean).length; }
  catch { return 0; }
}
