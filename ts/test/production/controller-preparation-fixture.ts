import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { HttpRegistry } from "../../src/controller/registry-client.ts";
import { checked, refuse } from "../../src/controller/errors.ts";
import { kernel, FaultJournal } from "./controller-port-fixture.ts";
import { fixture, use, type Fixture } from "./application-fixture.ts";
import { credential } from "./entry-http-fixture.ts";
import { nativeClient, nativeServer, readNative } from "./controller-preparation-native.ts";
import { serveOperator } from "../../src/application/operator-http.ts";
import { servePending } from "../../src/application/pending-http.ts";
import type { SalesStore } from "../../src/application/store.ts";
import type { TestContext } from "node:test";
import { paidMembers } from "./controller-rebuild-fixture.ts";

export const pendingCredential = "mock-preparation-pending-credential".padEnd(48, "x");
export async function withPreparation(t: TestContext, work: (k: ReturnType<typeof preparationKernel>, f: Fixture,
  native: Awaited<ReturnType<typeof nativeServer>>, store: SalesStore, operator: string) => Promise<void>) {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidMembers(store, f); const operator = yield* serveOperator(store, Effect.succeed(credential)), pending = yield* servePending(store, Effect.succeed(pendingCredential));
    const native = yield* Effect.promise(() => nativeServer(t, f.root, pending.url, pendingCredential));
    const k = preparationKernel(f, operator.url, native.url); yield* Effect.promise(() => work(k, f, native, store, operator.url));
  }));
}

export function preparationKernel(f: Fixture, operator: string, native: string) {
  const k = kernel(f.root, operator), db = new DatabaseSync(k.database); db.exec("delete from batches"); db.close();
  writeFileSync(k.journal.path, ""); const journal = new FaultJournal(k.directory), registry = new HttpRegistry(operator, Effect.succeed(credential));
  return { ...k, journal, config: { database: k.database, makeJournal: () => journal },
    ports: { ...k.ports, height: () => Effect.succeed(f.node.tip), preparation: { registry, native: nativeClient(native),
      chainRoot: (space: string) => checked("read recording prior root", () => {
        const value = readNative(f.root).spaces[space]; if (!value) refuse("recording space is not loaded"); return value.chain;
      }) } } };
}
