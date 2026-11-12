import { ownConfiguredInstallation } from "./installation-fence.ts";
import { observeIdentity } from "../bitcoin/observe-identity.ts";
import { bindIdentity } from "../bitcoin/identity.ts";
import { configuration, expectedIdentity } from "./config.ts";
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
export function recoveryCommand(mode: "restore" | "recover" | "reconcile" | "maintain", config: RuntimeConfig, controllerConfig?:string) {
  return Effect.gen(function* () {
    config = yield* checked(() => configuration(config));
    yield* ownConfiguredInstallation(config.maintenanceLock);
    const applicationConfig = {...config, installationExpectation: expectedIdentity(config)};
    if (mode === "restore") return yield* restoreApplication(applicationConfig);
    let bound = expectedIdentity(config);
    const settings = { ...config.core, network: config.network, identity: () => bound }, core = yield* CoreAdapter.make(settings);
    const sender = yield* CoreRefundSender.make(settings), supersessionChain = yield* conflictVerifier(settings);
    const denied = Effect.fail(new ApplicationError({ code: "unavailable", message: "wallet mutation is unavailable during recovery" }));
    const installationIdentity = observeIdentity(settings).pipe(Effect.flatMap(observed => checked(() => { bound = bindIdentity(bound ?? null, observed, false); return bound; })));
    const adapters={ installationIdentity, clock: () => Math.floor(Date.now()/1000),
      snapshot: destinations => core.snapshot(destinations), newDestination: denied,
      certificateChain: checkpoint => core.containsBlock(checkpoint), supersessionChain,
      refunds: { resolveAddress: () => denied, estimateRate: () => Effect.succeed(null), build: () => denied,
        sender: { observe: transactions => sender.observe(transactions), broadcast: () => denied } } } satisfies import("../application/store.ts").Adapters;
    if(mode==="reconcile" || mode==="maintain"){
      const controller=yield* checked(()=>controllerRecovery(config,controllerConfig!));
      return yield* (mode === 'maintain' ? SalesStore.reconcileMaintenance(applicationConfig,adapters,controller) :
        SalesStore.reconcileRecovery(applicationConfig,adapters,controller));
    }
    return yield* SalesStore.inspectRecovery(applicationConfig,adapters);
  });
}
