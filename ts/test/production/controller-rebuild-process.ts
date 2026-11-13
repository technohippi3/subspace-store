/** Disposable process-crash qualification with HTTP store and recording native ports. */
import { join } from "node:path";
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { Effect } from "effect";
import { BoundController } from "../../src/controller/issuance.ts";
import { FileControllerJournal } from "../../src/controller/journal.ts";
import { HttpRegistry } from "../../src/controller/registry-client.ts";
import { ControllerError } from "../../src/controller/errors.ts";
import type { Batch } from "../../src/controller/records.ts";
import type { Json } from "../../src/storage/codec.ts";
import { credential } from "./entry-http-fixture.ts";
import { delegate, txid } from "./controller-port-fixture.ts";
import { batches, RecordingNative } from "./controller-rebuild-fixture.ts";

const [root, origin, mode, bid = "b1", excluded = "o2", failure = "explicit"] = process.argv.slice(2);
if (!root || !origin || !mode) throw Error("invalid rebuild crash arguments");
class Journal extends FileControllerJournal {
  override append(value: Batch): void {
    if (mode === "stop-after-completion" && value.supersedes === bid ||
        mode === "stop-before-parent-ack" && value.bid === bid && value.state === "rebuilt") process.exit(9);
    super.append(value);
    if (mode === "stop-after-releasing" && value.bid === bid && value.state === "releasing" ||
        mode === "stop-after-rebuilding" && value.bid === bid && value.state === "rebuilding" ||
        mode === "stop-after-child-ack" && value.supersedes === bid ||
        mode === "stop-after-parent-ack" && value.bid === bid && value.state === "rebuilt") process.exit(9);
  }
  override appendEvent(kind: string, data: Readonly<Record<string, Json>>): void {
    super.appendEvent(kind, data);
    if (mode === "stop-after-rollback-intent" && kind === "entry_rollback_intent" ||
        mode === "stop-after-guard" && kind === "rebuild_guard" && data.count !== 0 ||
        mode === "stop-after-reset" && kind === "rebuild_guard" && data.count === 0) process.exit(9);
  }
}
const native = new RecordingNative(root), registry = new HttpRegistry(origin, Effect.succeed(credential));
native.afterRollback = () => {
  if (mode === "stop-after-rollback") process.exit(9);
  if (mode === "lose-rollback-reply") throw new ControllerError({ code: "unavailable", message: "lost rollback reply" });
};
native.afterPark = () => {
  if (mode === "stop-after-park") process.exit(9);
  if (mode === "lose-park-reply") throw new ControllerError({ code: "unavailable", message: "lost park reply" });
};
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const controller = yield* BoundController.open({ database: join(root, "controller.db"), makeJournal: () => new Journal(join(root, "controller-journal")) }, {
    registry, release: native, height: () => Effect.succeed(native.state().height), delegate: () => Effect.succeed(delegate),
    broadcast: () => Effect.sync(() => {
      const file = join(root, "rebuild-sends.jsonl"); appendFileSync(file, JSON.stringify({ txid }) + "\n");
      const fd = openSync(file, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
      return { status: 200, body: JSON.stringify({ txid }) };
    }), capture: () => Effect.succeed(null),
  });
  const error = yield* (mode === "issue" || mode === "stop-after-reset" ? controller.issue(bid).pipe(Effect.asVoid) :
    mode === "resume" ? controller.resumeRelease(bid).pipe(Effect.asVoid) :
      controller.releaseUnsent(bid, excluded ? excluded.split(",") : [], failure === "failure").pipe(Effect.asVoid))
    .pipe(Effect.match({ onSuccess: () => null, onFailure: error => error.message }));
  console.log(JSON.stringify({ error, batches: batches(join(root, "controller.db")), native: native.state(), alerts: yield* controller.alerts() }));
})));
