/** Actual old development kernel; journal reads are allowed, effect ports fail. */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { Scope } from "effect";
import type { BoundController as CurrentController } from "../../src/controller/issuance.ts";

const [source, database, directory, mode] = process.argv.slice(2);
if (!source || !database || !directory) throw Error("invalid legacy process arguments");
const { BoundController } = await import(pathToFileURL(join(source, "ts/src/controller/issuance.ts")).href);
const { FileControllerJournal, RemoteControllerJournal } = await import(pathToFileURL(join(source, "ts/src/controller/journal.ts")).href);
let calls = 0;
const forbidden = () => Effect.sync(() => { calls++; throw Error("legacy effect port reached"); });
const makeJournal = () => mode === "remote" ? new RemoteControllerJournal({ request(request: { op: string; after: number; limit: number }) {
  if (request.op !== "journal-read") { calls++; throw Error("legacy remote mutation reached"); }
  const lines = readFileSync(join(directory, "controller.jsonl"), "utf8").trimEnd().split("\n").filter(Boolean);
  return { head: lines.length, entries: lines.slice(request.after, request.after + request.limit).map((line, i) => {
    const raw = Buffer.from(line); return { sequence: request.after + i + 1, data: raw.toString("base64"), sha256: createHash("sha256").update(raw).digest("hex") };
  }) };
} }) : new FileControllerJournal(directory);
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const controller = yield* (BoundController.open({ database, makeJournal }, {
    registry: { failing: forbidden, lookup: forbidden, enter: forbidden, close: forbidden, order: forbidden, arm: forbidden },
    height: forbidden, delegate: forbidden, broadcast: forbidden, capture: forbidden,
  }) as Effect.Effect<CurrentController, Error, Scope.Scope>);
  yield* controller.batch("b1");
})).pipe(Effect.match({ onSuccess: () => ({ opened: true, calls }), onFailure: () => ({ opened: false, calls }) })));
console.log(JSON.stringify(result));
