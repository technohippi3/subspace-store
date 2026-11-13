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
import { certificateFixture } from "./certificate-fixture.ts";
import { controller, credential, faultProxy } from "./entry-http-fixture.ts";

function command(f: ReturnType<typeof certificateFixture>, url: string) {
  return async (mode = "certify") => {
    const args = ["test/production/certificate-controller-client.py", mode, url, join(f.root, "mock-operator-token"),
      f.config.database, f.config.journalDirectory, f.root];
    try {
      return JSON.parse((await promisify(execFile)("python3", args)).stdout) as { error: string | null; sends: number;
        result: { members: Record<string, { verified: boolean; delivered: boolean }> }; alerts: string[] };
    } catch (e) { if (e && typeof e === "object" && "code" in e && e.code === 9) return null; throw e; }
  };
}
test("O44: actual controller verification and client recover lost certificate replies and crashes for own/later roots", async (t) => {
  for (const fault of ["before", "after", "stop-after-certificate", "later-root"]) {
    const f = certificateFixture(t);
    await use(f, store => Effect.gen(function* () {
      const tokens = yield* paidPair(store, f), listener = yield* serveOperator(store, Effect.succeed(credential));
      const proxy = yield* Effect.promise(() => faultProxy(t, listener.url));
      yield* Effect.promise(() => controller(f, proxy.url)("issue"));
      writeFileSync(join(f.root, "mock-chain.json"), JSON.stringify(f.facts(50, 50, 210)));
      writeFileSync(join(f.root, "mock-certificate.json"), JSON.stringify({ root: (fault === "later-root" ? "c" : "a").repeat(64), height: fault === "later-root" ? 55 : 50 }));
      const certify = command(f, proxy.url);
      if (fault === "before") proxy.control.beforePath = "/operator/certificates";
      if (fault === "after") proxy.control.afterPath = "/operator/certificates";
      yield* Effect.promise(() => certify(fault === "stop-after-certificate" ? fault : "certify"));
      const recovered = yield* Effect.promise(() => certify()); assert(recovered);
      assert.equal(recovered.error, null); assert.equal(recovered.sends, 1);
      for (const token of tokens) { assert.equal((yield* store.order(token)).status, "ready"); assert((yield* store.certificate(token)).length > 0); }
      for (const member of Object.values(recovered.result.members)) { assert.equal(member.verified, true); assert.equal(member.delivered, true); }
    }));
  }
});
test("O45: changed chain, wrong recipient, dependent zone and failed verifier never create readiness", async (t) => {
  for (const bad of [{ change_tip: true }, { wrong_recipient: true }, { sovereignty: "dependent" }, { exit_code: 1 }, { verified: "yes" }]) {
    const f = certificateFixture(t);
    await use(f, store => Effect.gen(function* () {
      const tokens = yield* paidPair(store, f), listener = yield* serveOperator(store, Effect.succeed(credential));
      const proxy = yield* Effect.promise(() => faultProxy(t, listener.url)); yield* Effect.promise(() => controller(f, proxy.url)("issue"));
      writeFileSync(join(f.root, "mock-chain.json"), JSON.stringify(f.facts(50, 50, 210)));
      writeFileSync(join(f.root, "mock-certificate.json"), JSON.stringify({ root: "a".repeat(64), height: 50, ...bad }));
      const result = yield* Effect.promise(() => command(f, proxy.url)()); assert(result); assert.equal(result.sends, 1);
      assert(result.error || Object.values(result.result.members).every(v => !v.verified && !v.delivered));
      for (const token of tokens) assert.equal((yield* store.order(token)).certificate_available, false);
    }));
  }
});
