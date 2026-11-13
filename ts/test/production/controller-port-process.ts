/** Disposable SQLite/HTTP crash fixture. No native service or wallet is used. */
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { BoundController } from "../../src/controller/issuance.ts";
import { FileControllerJournal } from "../../src/controller/journal.ts";
import { HttpRegistry } from "../../src/controller/registry-client.ts";
import type { Batch } from "../../src/controller/records.ts";
import { credential } from "./entry-http-fixture.ts";
import { delegate, txid } from "./controller-port-fixture.ts";

const [root, origin, mode] = process.argv.slice(2);
if (!root || !origin || !mode) throw Error("invalid crash fixture arguments");
class Journal extends FileControllerJournal {
  override append(value: Batch): void {
    super.append(value);
    if (mode === "stop-after-identity" && value.state === "checkpointed" && value.entry_key ||
        mode === "stop-after-intent" && value.state === "issuing" && !value.attempted) process.exit(9);
  }
}
const registry = new HttpRegistry(origin, Effect.succeed(credential));
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const controller = yield* BoundController.open({ database: join(root, "controller.db"),
    makeJournal: () => new Journal(join(root, "controller-journal")) }, {
    registry: { failing: (b, issuing) => registry.failing(b, issuing), lookup: b => registry.lookup(b),
      enter: b => registry.enter(b).pipe(Effect.tap(() => Effect.sync(() => { if (mode === "stop-after-entry") process.exit(9); }))),
      arm: b => Effect.gen(function* () {
        if (mode === "stop-before-arm") process.exit(9);
        const answer = yield* registry.arm(b); if (mode === "stop-after-arm") process.exit(9); return answer;
      }) },
    delegate: () => Effect.succeed(delegate), broadcast: () => Effect.sync(() => {
      const path = join(root, "controller-sends.jsonl"); appendFileSync(path, JSON.stringify({ txid }) + "\n");
      const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
      if (mode === "stop-after-send") process.exit(9);
      return { status: 200, body: JSON.stringify({ txid }) };
    }), capture: () => Effect.succeed(null),
  });
  const before = yield* controller.batch("b1");
  const error = yield* (before.state === "checkpointed" ? controller.issue("b1") : controller.resume("b1"))
    .pipe(Effect.match({ onSuccess: () => null, onFailure: failure => failure.message }));
  const value = yield* controller.batch("b1");
  console.log(JSON.stringify({ state: value.state, attempted: value.attempted, entry: value.entry_key, error,
    alerts: yield* controller.alerts() }));
})));
