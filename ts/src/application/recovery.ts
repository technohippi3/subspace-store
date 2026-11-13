import { checkStoredIdentity } from "../bitcoin/identity.ts";
import { Effect } from "effect";
import { DurableStore, type StorageError } from "../storage/store.ts";
import { configuration } from "../refunds/book.ts";
import { allMembers } from "../refunds/families.ts";
import { settled } from "../refunds/observations.ts";
import { ApplicationError, checked, decode, fail, sats, type State } from "./records.ts";
import { invalidateCertificate } from "./certificate-records.ts";
import { persist } from "./persistence.ts";
import type { Adapters, Config } from "./store.ts";

function refundSettings(config: Config) {
  sats(config.riskBudgetSats);
  return configuration({ version: 1, policy: structuredClone(config.refundPolicy), merchantDestinations: structuredClone([...(config.merchantDestinations ?? [])]) });
}
/** Monotone and idempotent. No cached balance is reported as current here. */
export function prepareRecovery(state: State, sequence: number, fresh = false) {
  if (!state.recovery || fresh && !state.recovery.required) state.recovery = { version: 1, required: true, sourceSequence: sequence };
  if (!state.recovery.required) return;
  state.settings.paused = true; state.pending = [];
  for (const order of state.orders) if (order.destination) {
    if (state.payments.some(p => p.script === order.destination!.script)) order.paymentHistory = "detected";
    else if (order.paymentHistory !== "detected") order.paymentHistory = "unknown";
  }
  for (const cert of state.certificates) invalidateCertificate(state, cert, "application_restored");
}
export function prepareStoredRecovery(storage: DurableStore, config: Config, fresh = false) {
  return Effect.gen(function* () {
    const records = yield* storage.records();
    const state = yield* checked(() => decode(records, config.riskBudgetSats, refundSettings(config)));
    yield* checked(() => checkStoredIdentity(state.installation, config.network, config.installationExpectation, records.length > 0));
    const position = yield* storage.status();
    yield* checked(() => { validateRecoverySequence(state, position.seq); prepareRecovery(state, position.seq, fresh); });
    yield* persist(storage, records, state, config.riskBudgetSats, refundSettings(config));
    return state;
  });
}
function validateRecoverySequence(state: State, sequence: number) {
  if (state.recovery && state.recovery.sourceSequence >= sequence) fail("recovery marker exceeds journal history");
}
function receipt(storage: DurableStore, state: State, tipHash?: string) {
  return Effect.gen(function* () {
    yield* storage.flush(); const status = yield* storage.status();
    const acknowledged = yield* storage.confirm(status.seq);
    return { version: 1, ready: false, restore_required: status.restoreRequired, sales_paused: state.settings.paused,
      phase: tipHash ? "observed" : "restored", acknowledged, sequence: status.seq,
      chain: tipHash ? { height: state.settings.tip, hash: tipHash } : null,
      orders: { total: state.orders.length, unknown_payment_history: state.orders.filter(o => o.paymentHistory === "unknown").length,
        issuing: state.orders.filter(o => o.status === "issuing").length, fulfilled: state.fulfillments.length },
      issuance: { entries: state.entries.length, armed: state.arms.length, certificates: state.certificates.length,
        usable_certificates: state.certificates.filter(c => c.valid).length },
      refunds: { groups: state.groups.length, built: allMembers(state).filter(m => m.transaction).length,
        attempted: state.refundSends.length, settled: tipHash ? state.groups.filter(g => settled(state,g)).length : null },
      waiting: [...(!acknowledged ? ["journal_acknowledgment"] : []), ...(!tipHash ? ["chain_observation"] : []), "controller_reconciliation"] };
  });
}
/** Explicit journal-only replay. A valid serving path is published only after
 * domain preflight; the storage quarantine survives every later failure. */
export function restoreApplication(config: Config) {
  return Effect.gen(function* () {
    const refunds = yield* checked(() => refundSettings(config));
    const storage = yield* DurableStore.open({ ...config, restore: true,
      validateRestore: (records, sequence) => {
        if (!records.length) fail("empty application recovery set");
        const state = decode(records, config.riskBudgetSats, refunds);
        checkStoredIdentity(state.installation, config.network, config.installationExpectation, records.length > 0);
        validateRecoverySequence(state, sequence);
      } });
    return yield* receipt(storage, yield* prepareStoredRecovery(storage, config, true));
  });
}
/** Strip every wallet-mutation capability, including an adapter supplied by a
 * caller. The recovery command only observes and persists accounting facts. */
export function readOnly(adapters: Adapters): Adapters {
  const denied = Effect.fail(new ApplicationError({ code: "unavailable", message: "wallet mutation is unavailable during recovery" }));
  return { ...adapters, newDestination: denied,
    ...(adapters.refunds ? { refunds: { resolveAddress: () => denied, estimateRate: () => Effect.succeed(null), build: () => denied,
      ...(adapters.refunds.sender ? { sender: { observe: adapters.refunds.sender.observe, broadcast: () => denied } } : {}) } } : {}) };
}
export function inspectRecovered(config: Config, adapters: Adapters,
  observe: (storage: DurableStore, readOnly: Adapters) => Effect.Effect<{ state: State; tipHash?: string | undefined }, ApplicationError | StorageError>) {
  return Effect.gen(function* () {
    const storage = yield* DurableStore.open({ ...config, restore: false, requireRestore: true });
    const state = yield* prepareStoredRecovery(storage, config), initial = yield* receipt(storage, state);
    if (!initial.acknowledged) return initial;
    yield* checked(() => { if (allMembers(state).some(m => m.transaction) && !adapters.refunds?.sender) fail("refund observation adapter required", "unavailable"); });
    const current = yield* observe(storage, readOnly(adapters));
    yield* checked(() => { if (!current.tipHash || !/^[0-9a-f]{64}$/.test(current.tipHash)) fail("coherent recovery tip required", "unavailable"); });
    return yield* receipt(storage, current.state, current.tipHash);
  });
}
