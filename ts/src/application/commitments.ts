import { Effect } from "effect";
import { armInput } from "./bound-records.ts";
import { armed, reportInput, summary } from "./commitment-records.ts";
import { checked, fail, type State } from "./records.ts";
import type { RegistryContext } from "./registry.ts";
import { invalidateCommitmentCertificates } from "./certificate-records.ts";

/** Trusted controller observations, never a chain verifier or send path.
 * A revision comparison prevents delayed reports overwriting newer facts. */
export class Commitments {
  private readonly context: RegistryContext;
  constructor(context: RegistryContext) { this.context = context; }
  private receipt(state: State, input: ReturnType<typeof armInput>) {
    const c = this.context;
    return Effect.gen(function* () {
      const arm = yield* checked(() => armed(state, input));
      const entry = state.entries.find(e => e.id === input.id)!;
      const record = state.commitments.find(r => r.entry === input.id);
      yield* c.storage.flush();
      let acknowledged = true;
      for (const [kind, key, value] of [["entry_arm", arm.id, arm], ["issuance_entry", entry.id, entry],
        ...(record ? [["commitment", record.entry, record]] : [])] as const) {
        const saved = yield* c.storage.acknowledged(kind as string, key as string);
        if (!saved || JSON.stringify(saved.value) !== JSON.stringify(value) || !(yield* c.storage.confirm(saved.seq))) { acknowledged = false; break; }
      }
      return { entry: arm.id, root: arm.root, oids: [...arm.oids], delegate: arm.delegate,
        revision: record?.revision ?? 0, observation: record ? summary(record.observation) : null, acknowledged };
    });
  }
  current(value: unknown) {
    const self = this, c = this.context;
    return Effect.gen(function* () {
      const input = yield* checked(() => armInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { state } = yield* c.load(); return yield* self.receipt(state, input);
      }));
    });
  }
  observe(value: unknown) {
    const self = this, c = this.context;
    return Effect.gen(function* () {
      const input = yield* checked(() => reportInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { records, state, tipHash } = yield* c.refresh();
        yield* checked(() => {
          armed(state, input);
          if (!tipHash || tipHash !== input.observation.tipHash || state.settings.tip !== input.observation.tipHeight)
            fail("commitment report tip differs from the store; retry", "unavailable");
          const previous = state.commitments.find(r => r.entry === input.id);
          if (previous && previous.observation.txid !== input.observation.txid) fail("commitment transaction identity changed");
          if (previous?.revision === input.expectedRevision + 1 && JSON.stringify(previous.observation) === JSON.stringify(input.observation)) return;
          if ((previous?.revision ?? 0) !== input.expectedRevision) fail("commitment revision changed; retry");
          if (previous) { previous.revision++; previous.observation = structuredClone(input.observation); }
          else state.commitments.push({ version: 1, entry: input.id, revision: 1, observation: structuredClone(input.observation) });
          invalidateCommitmentCertificates(state, input.id);
        });
        yield* c.save(records, state); return yield* self.receipt(state, input);
      }));
    });
  }
}
