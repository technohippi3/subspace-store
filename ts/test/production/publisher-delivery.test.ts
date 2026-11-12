import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { certificateFixture } from "./certificate-fixture.ts";
import { paidPair } from "./entry-fixture.ts";
import { use } from "./application-fixture.ts";
import { controller, credential, faultProxy } from "./entry-http-fixture.ts";

function publisher(f: ReturnType<typeof certificateFixture>, url: string) {
  return async (mode: string) => {
    try {
      const result = await promisify(execFile)("python3", ["test/production/certificate-controller-client.py", mode,
        url, join(f.root, "mock-operator-token"), f.config.database, f.config.journalDirectory, f.root]);
      return JSON.parse(result.stdout) as { error: string | null; sends: number; publish_calls: number;
        result: { outstanding: string[]; delivery: Record<string, { confirmed: boolean; waiting?: boolean }> } };
    } catch (e) { if (e && typeof e === "object" && "code" in e && e.code === 9) return null; throw e; }
  };
}
test("O53: shipped publisher and HTTP client recover fulfillment reply loss and crashes without another send or publish", async (t) => {
  for (const fault of ["before", "after", "stop-after-fulfillment", "stop-after-local-delivery"]) {
    const f = certificateFixture(t);
    await use(f, store => Effect.gen(function* () {
      const tokens = yield* paidPair(store, f), listener = yield* serveOperator(store, Effect.succeed(credential));
      const proxy = yield* Effect.promise(() => faultProxy(t, listener.url)); yield* Effect.promise(() => controller(f, proxy.url)("issue"));
      writeFileSync(join(f.root, "mock-chain.json"), JSON.stringify(f.facts(50, 50, 210)));
      writeFileSync(join(f.root, "mock-certificate.json"), JSON.stringify({ root: "a".repeat(64), height: 50 }));
      const command = publisher(f, proxy.url); assert.equal((yield* Effect.promise(() => command("certify")))!.error, null);
      if (fault === "before") proxy.control.beforePath = "/operator/fulfillments";
      if (fault === "after") proxy.control.afterPath = "/operator/fulfillments";
      yield* Effect.promise(() => command(fault.startsWith("stop-") ? fault : "publish"));
      const recovered = yield* Effect.promise(() => command("publish")); assert(recovered);
      assert.equal(recovered.error, null); assert.equal(recovered.sends, 1); assert.equal(recovered.publish_calls, 1);
      assert.deepEqual(recovered.result.outstanding, []);
      for (const token of tokens) assert.equal((yield* store.order(token)).status, "fulfilled");
    }));
  }
});
test("O54: temporary publication, immature roots, invalid verifier and changed chain cannot confirm delivery", async (t) => {
  for (const bad of [{ publish_status: "temp" }, { root: "c".repeat(64), height: 61 },
    { wrong_recipient: true }, { sovereignty: "dependent" }, { exit_code: 1 }, { verified: "yes" }, { change_tip_during_lookup: true }]) {
    const f = certificateFixture(t);
    await use(f, store => Effect.gen(function* () {
      const tokens = yield* paidPair(store, f), listener = yield* serveOperator(store, Effect.succeed(credential));
      const proxy = yield* Effect.promise(() => faultProxy(t, listener.url)); yield* Effect.promise(() => controller(f, proxy.url)("issue"));
      writeFileSync(join(f.root, "mock-chain.json"), JSON.stringify(f.facts(50, 50, 210)));
      const settings = join(f.root, "mock-certificate.json"), good = { root: "a".repeat(64), height: 50 };
      writeFileSync(settings, JSON.stringify(good)); const command = publisher(f, proxy.url);
      assert.equal((yield* Effect.promise(() => command("certify")))!.error, null);
      writeFileSync(settings, JSON.stringify({ ...good, ...bad }));
      const result = yield* Effect.promise(() => command("publish")); assert(result); assert.equal(result.sends, 1);
      assert(result.error || Object.values(result.result.delivery).every(v => !v.confirmed));
      for (const token of tokens) assert.notEqual((yield* store.order(token)).status, "fulfilled");
    }));
  }
});
