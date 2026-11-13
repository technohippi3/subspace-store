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
import { supersessionFixture } from "./supersession-fixture.ts";
import { controller, credential, faultProxy } from "./entry-http-fixture.ts";

test("O76: shipped supersession command recovers lost replies and process exit, then refuses conflicted reversal without another send", async (t) => {
  for (const fault of ["before", "after", "stop-after-proof"]) {
    const f = supersessionFixture(t);
    await use(f, store => Effect.gen(function* () {
      const tokens = yield* paidPair(store, f), listener = yield* serveOperator(store, Effect.succeed(credential));
      const proxy = yield* Effect.promise(() => faultProxy(t, listener.url));
      assert.equal((yield* Effect.promise(() => controller(f, proxy.url)("issue"))).sends, 1);
      f.node.tip = 300; f.chain.hash = "c".repeat(64);
      writeFileSync(join(f.root, "mock-chain.json"), JSON.stringify(f.facts(null, null, 300)));
      const command = async (mode = "supersede") => {
        try {
          return JSON.parse((await promisify(execFile)("python3", ["test/production/supersession-controller-client.py", mode,
            proxy.url, join(f.root, "mock-operator-token"), f.config.database, f.config.journalDirectory, f.root])).stdout) as {
            state: string; error: string | null; sends: number; alerts: string[] };
        } catch (e) { if (e && typeof e === "object" && "code" in e && e.code === 9) return null; throw e; }
      };
      if (fault === "before") proxy.control.beforePath = "/operator/supersessions";
      if (fault === "after") proxy.control.afterPath = "/operator/supersessions";
      yield* Effect.promise(() => command(fault === "stop-after-proof" ? fault : "supersede"));
      const done = yield* Effect.promise(() => command()); assert(done);
      assert.equal(done.error, null); assert.equal(done.state, "superseded"); assert.equal(done.sends, 1);
      for (const token of tokens) assert.equal((yield* store.order(token)).status, "converted");
      yield* store.cancel(tokens[1]!); f.control.valid = false;
      for (let i = 0; i < 2; i++) {
        const reversed = yield* Effect.promise(() => command("watch")); assert(reversed);
        assert.match(reversed.error!, /manual recovery/); assert.equal(reversed.state, "broadcast"); assert.equal(reversed.sends, 1);
        assert.equal(reversed.alerts.filter(a => a === "supersession_reversed").length, 1);
      }
      assert.equal((yield* store.order(tokens[0]!)).status, "issuing");
      assert.equal((yield* store.order(tokens[1]!)).status, "cancelled");
    }));
  }
});
