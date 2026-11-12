import { Effect } from "effect";
import { loadConfiguration } from "./runtime/config.ts";
import { startRuntime } from "./runtime/server.ts";
import { recoveryCommand } from "./runtime/recovery.ts";

const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try {
  const mode = process.argv[2], recovery = mode === "restore" || mode === "recover";
  if (process.argv.length !== (recovery ? 4 : 3)) throw Error("configuration required");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const config = yield* loadConfiguration(process.argv[recovery ? 3 : 2]!);
    if (recovery) {
      const report = yield* recoveryCommand(mode, config);
      process.stdout.write(JSON.stringify(report) + "\n");
      if (!report.acknowledged) process.exitCode = 2;
      return;
    }
    yield* startRuntime(config);
    process.stdout.write(JSON.stringify({ event: "ready", network: "regtest" }) + "\n");
    yield* Effect.never;
  })), { signal: controller.signal });
} catch {
  if (!controller.signal.aborted) { process.stderr.write("store runtime failed; configuration, credentials or local services unavailable\n"); process.exitCode = 1; }
} finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
