import {NativeArtifacts,CertificateExports} from "../application/certificate-export.ts";
import {trustedRootAnchors} from "./export-anchors.ts";
import { ownConfiguredInstallation } from "./installation-fence.ts";
import { Effect } from "effect";
import { SalesStore } from "../application/store.ts";
import { serve } from "../application/http.ts";
import { serveOperator } from "../application/operator-http.ts";
import { servePending } from "../application/pending-http.ts";
import { CoreAdapter } from "../bitcoin/core.ts";
import { CoreRefundWallet } from "../bitcoin/refunds.ts";
import { CoreRefundSender } from "../bitcoin/refund-sender.ts";
import { observeIdentity } from "../bitcoin/observe-identity.ts";
import { bindIdentity } from "../bitcoin/identity.ts";
import { configuration, expectedIdentity } from "./config.ts";
import { credentials } from "./credentials.ts";
import { checked } from "../application/records.ts";
import { conflictVerifier } from "../bitcoin/supersession.ts";

/** One process, one store owner and one sequential observer. Never sends refunds. */
export function startRuntime(value: unknown) {
  return Effect.gen(function* () {
    const config = yield* checked(() => configuration(value));
    yield* ownConfiguredInstallation(config.maintenanceLock);
    const tokens = credentials(config.credentials);
    yield* tokens.operator;
    let bound = expectedIdentity(config);
    const coreConfig = { ...config.core, network: config.network, identity: () => bound };
    const installationIdentity = observeIdentity(coreConfig).pipe(Effect.flatMap(observed => checked(() => { bound = bindIdentity(bound ?? null, observed, false); return bound; })));
    const core = yield* CoreAdapter.make(coreConfig), refunds = yield* CoreRefundWallet.make(coreConfig), sender = yield* CoreRefundSender.make(coreConfig);
    const supersessionChain = yield* conflictVerifier(coreConfig);
    const store = yield* SalesStore.open({...config, installationExpectation: expectedIdentity(config), startupPause: config.version === 2}, {
      installationIdentity, clock: () => Math.floor(Date.now() / 1000), snapshot: destinations => core.snapshot(destinations),
      newDestination: core.newDestination(), certificateChain: checkpoint => core.containsBlock(checkpoint),
      supersessionChain,
      chainStatus: core.checkReady().pipe(Effect.map(tip => ({ network: config.network, best_block_hash: tip.hash, blocks: tip.height }))),
      refunds: { resolveAddress: address => refunds.resolveAddress(address), estimateRate: target => refunds.estimateRate(target),
        assessExcess: request => refunds.assessExcess(request), build: request => refunds.build(request),
        rebuildFunding: request => refunds.rebuildFunding(request), sender },
    });
    // No listener or ready signal before initial observation/reconciliation.
    yield* store.observe();
    const exports=config.certificateExport;
    const certificateExports=exports?new CertificateExports({store,artifacts:new NativeArtifacts({binary:exports.binary,artifactManifest:exports.artifactManifest,directory:exports.directory,anchorsFor:trustedRootAnchors(exports.spaced,core)}),origin:exports.trustedOrigin,clock:()=>Math.floor(Date.now()/1000),ttlSeconds:exports.ttlSeconds,allowLoopbackHttp:config.network==="regtest"}):undefined;
    const buyer = yield* serve(store, config.listen.buyer,certificateExports);
    const operator = yield* serveOperator(store, tokens.operator, config.listen.operator);
    const subs = yield* servePending(store, tokens.subs, config.listen.subs);
    const poll = Effect.gen(function* () {
      yield* Effect.sleep(config.pollMilliseconds);
      yield* store.observe().pipe(Effect.matchEffect({ onSuccess: () => Effect.void,
        onFailure: () => store.tick().pipe(Effect.ignore) }));
    });
    yield* Effect.forkScoped(Effect.forever(poll));
    return { store, buyer: buyer.url, operator: operator.url, subs: subs.url };
  });
}
