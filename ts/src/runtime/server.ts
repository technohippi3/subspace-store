import { Effect } from "effect";
import { SalesStore } from "../application/store.ts";
import { serve } from "../application/http.ts";
import { serveOperator } from "../application/operator-http.ts";
import { servePending } from "../application/pending-http.ts";
import { CoreAdapter } from "../bitcoin/core.ts";
import { CoreRefundWallet } from "../bitcoin/refunds.ts";
import { CoreRefundSender } from "../bitcoin/refund-sender.ts";
import { configuration } from "./config.ts";
import { credentials } from "./credentials.ts";
import { checked } from "../application/records.ts";

/** One process, one store owner and one sequential observer. Never sends refunds. */
export function startRuntime(value: unknown) {
  return Effect.gen(function* () {
    const config = yield* checked(() => configuration(value)), tokens = credentials(config.credentials);
    yield* tokens.operator;
    const coreConfig = { ...config.core, network: config.network };
    const core = yield* CoreAdapter.make(coreConfig), refunds = yield* CoreRefundWallet.make(coreConfig), sender = yield* CoreRefundSender.make(coreConfig);
    const store = yield* SalesStore.open(config, {
      clock: () => Math.floor(Date.now() / 1000), snapshot: destinations => core.snapshot(destinations),
      newDestination: core.newDestination(), certificateChain: checkpoint => core.containsBlock(checkpoint),
      chainStatus: core.checkReady().pipe(Effect.map(tip => ({ network: config.network, best_block_hash: tip.hash, blocks: tip.height }))),
      refunds: { resolveAddress: address => refunds.resolveAddress(address), estimateRate: target => refunds.estimateRate(target),
        assessExcess: request => refunds.assessExcess(request), build: request => refunds.build(request),
        rebuildFunding: request => refunds.rebuildFunding(request), sender },
    });
    // No listener or ready signal before initial observation/reconciliation.
    yield* store.observe();
    const buyer = yield* serve(store, config.listen.buyer);
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
