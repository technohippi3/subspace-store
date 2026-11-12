import { Effect } from 'effect';
import { DurableStore, type StorageError } from '../storage/store.ts';
import { checkStoredIdentity } from '../bitcoin/identity.ts';
import { configuration } from '../refunds/book.ts';
import { allMembers } from '../refunds/families.ts';
import { ApplicationError, checked, decode, fail, type Record, type State } from './records.ts';
import { inventory, statement } from './reconciliation-records.ts';
import type { RecoveryController } from './reconciliation.ts';
import { persist } from './persistence.ts';
import { readOnly } from './recovery.ts';
import { prepareStartupPause } from './startup-pause.ts';
import type { Adapters, Config } from './store.ts';
import { existsSync } from 'node:fs';

type Observation = { state: State; records: readonly Record[]; tipHash?: string | undefined };
/** Normal same-database update proof. Never enters or clears host-loss recovery. */
export function reconcileMaintenance(config: Config, adapters: Adapters, controller: RecoveryController,
  observe: (storage: DurableStore, readOnly: Adapters) => Effect.Effect<Observation, ApplicationError | StorageError>) {
  return Effect.gen(function* () {
    yield* checked(() => { if (!existsSync(config.database)) fail('maintenance requires an existing initialized store'); });
    const storage = yield* DurableStore.open({ ...config, restore: false });
    if ((yield* storage.status()).restoreRequired) return yield* checked(() => fail('actual restore requires full reconciliation'));
    const records = yield* storage.records();
    yield* checked(() => { if (!records.length) fail('maintenance requires initialized application records'); });
    const refunds = configuration({ version: 1, policy: config.refundPolicy, merchantDestinations: [...(config.merchantDestinations ?? [])] });
    const state = yield* checked(() => decode(records, config.riskBudgetSats, refunds));
    yield* checked(() => {
      checkStoredIdentity(state.installation, config.network, config.installationExpectation, records.length > 0);
      if (state.recovery?.required) fail('actual restore requires full reconciliation');
      if (allMembers(state).some(member => member.transaction) && !adapters.refunds?.sender) fail('refund observation adapter required');
      prepareStartupPause(state);
    });
    yield* persist(storage, records, state, config.riskBudgetSats, refunds);
    yield* storage.flush(); const paused = yield* storage.checkpoint();
    if (!(yield* storage.confirm(paused.sequence))) return { ready: false, acknowledged: false, sales_paused: true, waiting: ['store_journal'] };
    const current = yield* observe(storage, readOnly(adapters)), checkpoint = yield* storage.checkpoint();
    const transient = (state: State) => ({ ...state, recovery: { version: 1 as const, required: true as const, sourceSequence: checkpoint.sequence } });
    const input = yield* checked(() => {
      if (!current.tipHash || !current.state.settings.paused) fail('paused coherent maintenance tip required');
      return inventory(transient(current.state), checkpoint.store, checkpoint.sequence, current.tipHash);
    });
    if (!(yield* storage.confirm(checkpoint.sequence))) return { ready: false, acknowledged: false, sales_paused: true, waiting: ['store_journal'] };
    const raw = yield* controller.run(input), proof = yield* checked(() => statement(raw, input));
    yield* controller.verify(proof); yield* controller.confirm(proof);
    const latest = yield* observe(storage, readOnly(adapters)), now = yield* storage.checkpoint();
    yield* checked(() => {
      if (!latest.tipHash || !latest.state.settings.paused || latest.state.recovery?.required) fail('maintenance state changed');
      const next = inventory(transient(latest.state), now.store, now.sequence, latest.tipHash);
      if (JSON.stringify({ ...input, sequence: 0 }) !== JSON.stringify({ ...next, sequence: 0 })) fail('maintenance inventory or tip changed; retry');
    });
    if (!(yield* storage.confirm(now.sequence))) return { ready: false, acknowledged: false, sales_paused: true, waiting: ['store_journal'] };
    yield* controller.confirm(proof);
    return { ready: true, acknowledged: true, sales_paused: true, waiting: [],
      proof_hash: proof.proofHash, controller_sequence: proof.position, source_sequence: checkpoint.sequence };
  });
}
