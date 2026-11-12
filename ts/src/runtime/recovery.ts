import { Effect } from "effect";
import { CoreAdapter } from "../bitcoin/core.ts";
import { CoreRefundSender } from "../bitcoin/refund-sender.ts";
import { conflictVerifier } from "../bitcoin/supersession.ts";
import { SalesStore } from "../application/store.ts";
import { ApplicationError } from "../application/records.ts";
import { restoreApplication } from "../application/recovery.ts";
import type { RuntimeConfig } from "./config.ts";

/** No listeners, credential fetch, address allocation, signing or sending. */
export function recoveryCommand(mode: "restore" | "recover", config: RuntimeConfig) {
  if (mode === "restore") return restoreApplication(config);
  return Effect.gen(function* () {
    const settings = { ...config.core, network: config.network }, core = yield* CoreAdapter.make(settings);
    const sender = yield* CoreRefundSender.make(settings), supersessionChain = yield* conflictVerifier(settings);
    const denied = Effect.fail(new ApplicationError({ code: "unavailable", message: "wallet mutation is unavailable during recovery" }));
    return yield* SalesStore.inspectRecovery(config, { clock: () => Math.floor(Date.now()/1000),
      snapshot: destinations => core.snapshot(destinations), newDestination: denied,
      certificateChain: checkpoint => core.containsBlock(checkpoint), supersessionChain,
      refunds: { resolveAddress: () => denied, estimateRate: () => Effect.succeed(null), build: () => denied,
        sender: { observe: transactions => sender.observe(transactions), broadcast: () => denied } } });
  });
}
