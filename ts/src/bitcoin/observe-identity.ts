import { Effect } from "effect";
import { CoreAdapter, type CoreConfig } from "./core.ts";
import { BitcoinRpc } from "./rpc.ts";
import { ApplicationError, checked, fail } from "../application/records.ts";
import { GENESIS, descriptorFingerprint, identity } from "./identity.ts";

/** Fresh read-only identity qualification against the same synchronized tip.
 * listdescriptors(false) requests public expressions only; raw descriptors
 * remain in memory and never enter installation state or diagnostics. */
export function observeIdentity(config: CoreConfig) {
  return Effect.gen(function* () {
    if (config.network !== "main" && config.network !== "regtest")
      return yield* checked(() => fail("unsupported Spaces network", "unavailable"));
    const core = yield* CoreAdapter.make(config), wallet = new BitcoinRpc(config);
    const { wallet: _wallet, ...nodeConfig } = config;
    const node = new BitcoinRpc(nodeConfig), before = yield* core.checkReady();
    const genesis = yield* node.call("getblockhash", 0);
    const descriptors = yield* wallet.call("listdescriptors", false);
    const observed = yield* Effect.try({ try: () => identity({ version: 1, network: config.network,
      genesis, wallet: config.wallet, descriptorHash: descriptorFingerprint(descriptors) }),
      catch: () => new ApplicationError({code:"unavailable",message:"installation network or payment wallet identity differs"}) });
    const after = yield* core.checkReady();
    return yield* checked(() => {
      if (before.hash !== after.hash || before.height !== after.height || observed.genesis !== GENESIS[observed.network])
        fail("chain changed during installation identity observation", "unavailable");
      return observed;
    });
  }).pipe(Effect.mapError(error => error instanceof ApplicationError ? error : new ApplicationError({code:"unavailable",message:"installation network or payment wallet identity differs, or Core is not ready at one tip"})));
}
