import { Effect } from "effect";
import { loadConfiguration } from "./runtime/config.ts";
import { startRuntime } from "./runtime/server.ts";

const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try {
  if (process.argv.length !== 3) throw Error("configuration required");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* startRuntime(yield* loadConfiguration(process.argv[2]!));
    process.stdout.write(JSON.stringify({ event: "ready", network: "regtest" }) + "\n");
    yield* Effect.never;
  })), { signal: controller.signal });
} catch {
  if (!controller.signal.aborted) { process.stderr.write("store runtime failed; configuration, credentials or local services unavailable\n"); process.exitCode = 1; }
} finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
