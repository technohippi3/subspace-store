import { Effect } from "effect";
import { CoreAdapter } from "../bitcoin/core.ts";
import { CoreRefundSender } from "../bitcoin/refund-sender.ts";
import { conflictVerifier } from "../bitcoin/supersession.ts";
import { SalesStore } from "../application/store.ts";
import { ApplicationError } from "../application/records.ts";
import { restoreApplication } from "../application/recovery.ts";
import type { RuntimeConfig } from "./config.ts";
import { controllerRecovery } from "./reconciliation.ts";
import { checked } from "../application/records.ts";

/** No listeners, credential fetch, address allocation, signing or sending. */
export function recoveryCommand(mode: "restore" | "recover" | "reconcile", config: RuntimeConfig, controllerConfig?:string) {
  if (mode === "restore") return restoreApplication(config);
  return Effect.gen(function* () {
    const settings = { ...config.core, network: config.network }, core = yield* CoreAdapter.make(settings);
    const sender = yield* CoreRefundSender.make(settings), supersessionChain = yield* conflictVerifier(settings);
    const denied = Effect.fail(new ApplicationError({ code: "unavailable", message: "wallet mutation is unavailable during recovery" }));
    const adapters={ clock: () => Math.floor(Date.now()/1000),
      snapshot: destinations => core.snapshot(destinations), newDestination: denied,
      certificateChain: checkpoint => core.containsBlock(checkpoint), supersessionChain,
      refunds: { resolveAddress: () => denied, estimateRate: () => Effect.succeed(null), build: () => denied,
        sender: { observe: transactions => sender.observe(transactions), broadcast: () => denied } } } satisfies import("../application/store.ts").Adapters;
    if(mode==="reconcile"){
      const controller=yield* checked(()=>controllerRecovery(config,controllerConfig!));
      return yield* SalesStore.reconcileRecovery(config,adapters,controller);
    }
    return yield* SalesStore.inspectRecovery(config,adapters);
  });
}
