import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { use } from "./application-fixture.ts";
import { paidPair } from "./entry-fixture.ts";
import { commitmentFixture } from "./commitment-fixture.ts";
import { controller, credential, faultProxy } from "./entry-http-fixture.ts";

test("O34: the shipped watch path tracks mining, finality, root loss and reorgs without another send", async (t) => {
  const f = commitmentFixture(t); f.node.tip = 200;
  await use(f, store => Effect.gen(function* () {
    yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
    const proxy = yield* Effect.promise(() => faultProxy(t, listener.url));
    assert.equal((yield* Effect.promise(() => controller(f, proxy.url)("issue"))).sends, 1);
    const args = ["test/production/commitment-controller-client.py", "preparation-fault", proxy.url, join(f.root, "mock-operator-token"),
      f.config.database, f.config.journalDirectory, f.root];
    const watch = async (height: number | null, root = height, anchor: number | null = null) => {
      writeFileSync(join(f.root, "mock-chain.json"), JSON.stringify(f.facts(height, root, anchor)));
      const result = await promisify(execFile)("python3", args);
      return JSON.parse(result.stdout) as { state: string; error: string | null; sends: number; finality_losses: number };
    };
    for (const [height, root, anchor, phase] of [[51, 51, 200, "mined"], [50, 50, 193, "final"],
      [50, null, 200, "mined"], [50, 50, 194, "final"], [null, null, null, "broadcast"]] as const) {
      const result = yield* Effect.promise(() => watch(height, root, anchor));
      assert.equal(result.error, null); assert.equal(result.state, phase); assert.equal(result.sends, 1);
    }
    assert.equal((yield* Effect.promise(() => watch(null))).finality_losses, 2);
    for (const id of ["o1", "o2"]) assert.equal((yield* store.inspectionOrder(id)).status, "issuing");
  }));
});
test("O35: a lost observation reply or exit after its commit resumes with fresh facts and one original send", async (t) => {
  for (const fault of ["before", "after", "stop-after-report"]) {
    const f = commitmentFixture(t); f.node.tip = 200;
    await use(f, store => Effect.gen(function* () {
      yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      const proxy = yield* Effect.promise(() => faultProxy(t, listener.url));
      yield* Effect.promise(() => controller(f, proxy.url)("issue"));
      writeFileSync(join(f.root, "mock-chain.json"), JSON.stringify(f.facts(50, 50, 200)));
      const watch = async (mode = "watch") => {
        const args = ["test/production/commitment-controller-client.py", mode, proxy.url, join(f.root, "mock-operator-token"),
          f.config.database, f.config.journalDirectory, f.root];
        try { return JSON.parse((await promisify(execFile)("python3", args)).stdout) as { state: string; sends: number; error: string | null }; }
        catch (e) { if (e && typeof e === "object" && "code" in e && e.code === 9) return null; throw e; }
      };
      if (fault === "before") proxy.control.beforePath = "/operator/commitments";
      if (fault === "after") proxy.control.afterPath = "/operator/commitments";
      yield* Effect.promise(() => watch(fault === "stop-after-report" ? fault : "watch"));
      const recovered = yield* Effect.promise(() => watch()); assert(recovered);
      assert.equal(recovered.error, null); assert.equal(recovered.state, "final"); assert.equal(recovered.sends, 1);
    }));
  }
});
