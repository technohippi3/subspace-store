/** Abrupt exits at real persistence/HTTP boundaries over disposable recording state. */
import { join } from "node:path";
import { Effect } from "effect";
import { BoundController } from "../../src/controller/issuance.ts";
import { FileControllerJournal } from "../../src/controller/journal.ts";
import { HttpRegistry } from "../../src/controller/registry-client.ts";
import { checked, refuse } from "../../src/controller/errors.ts";
import type { Batch } from "../../src/controller/records.ts";
import type { Json } from "../../src/storage/codec.ts";
import { nativeClient, readNative } from "./controller-preparation-native.ts";
import { batches } from "./controller-rebuild-fixture.ts";
import { credential } from "./entry-http-fixture.ts";
import { delegate } from "./controller-port-fixture.ts";

const [root, operator, native, operation, mode = "continue", bid = "b1"] = process.argv.slice(2);
if (!root || !operator || !native || !operation) throw Error("invalid preparation crash arguments");
class Journal extends FileControllerJournal {
  override append(value: Batch): void {
    if (mode === "before-committed-ack" && value.state === "committed_local") process.exit(9);
    super.append(value);
    if (mode === "after-freeze" && value.state === "frozen" || mode === "after-staged" && value.state === "staged" ||
        mode === "after-committed" && value.state === "committed_local" || mode === "after-abort-retired" && value.state === "rebuilt") process.exit(9);
  }
  override appendEvent(kind: string, data: Readonly<Record<string, Json>>): void {
    super.appendEvent(kind, data);
    if (mode === "after-owner" && kind === "preparation_pending" && data.phase === "owned" ||
        mode === "after-abort" && kind === "preparation_abort" ||
        mode === "after-clear-owner" && kind === "preparation_pending" && data.phase === "cleared" ||
        mode === "after-commit-intent" && kind === "commit_local_intent" ||
        kind === "preparation_effect" && mode === `after-${String(data.operation)}-${String(data.phase)}`) process.exit(9);
  }
}
const registry = new HttpRegistry(operator, Effect.succeed(credential)), transport = nativeClient(native);
const ports = { ...transport, commit: (space: string) => transport.commit(space).pipe(Effect.tap(() => Effect.sync(() => { if (mode === "after-commit-response") process.exit(9); }))) };
const output = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const c = yield* BoundController.open({ database: join(root, "controller.db"), makeJournal: () => new Journal(join(root, "controller-journal")) }, {
    registry, height: () => Effect.succeed(10), delegate: () => Effect.succeed(delegate),
    broadcast: () => checked("forbid recording broadcast", () => refuse("preparation must not broadcast")), capture: () => Effect.succeed(null),
    preparation: { registry, native: ports, chainRoot: (space: string) => checked("read recording chain", () => {
      const current = readNative(root).spaces[space]; if (!current) refuse("recording space not loaded"); return current.chain;
    }) },
  });
  return yield* (operation === "freeze" ? c.freeze("@space") : operation === "stage" ? c.stage(bid) : operation === "abort" ? c.abortPreparation(bid) : c.commitLocal(bid));
})).pipe(Effect.match({ onSuccess: value => ({ error: null, value }), onFailure: error => ({ error: error.message, value: null }) })));
console.log(JSON.stringify({ ...output, batches: batches(join(root, "controller.db")) }));
