import { Effect } from "effect";
import type { RegistryContext } from "./registry.ts";
import { checked, fail, type ApplicationError, type Snapshot, type State } from "./records.ts";
import { armed } from "./commitment-records.ts";
import { armInput } from "./bound-records.ts";
import { applySupersession, revokeSupersession, supersessionInput, usableEntry, type SupersessionCheck } from "./supersession-records.ts";
import { reconcile } from "./monitor.ts";

export type SupersessionChain = (check: SupersessionCheck) => Effect.Effect<boolean, ApplicationError>;
export function checkSupersessions(state: State, snapshot: Snapshot, chain: SupersessionChain | undefined) {
  return Effect.gen(function* () {
    if (state.supersessions.length && !chain) return yield* checked(() => fail("supersession chain adapter required", "unavailable"));
    for (const proof of state.supersessions.filter(s => s.active)) {
      if (!snapshot.tipHash) return yield* checked(() => fail("supersession chain tip unavailable", "unavailable"));
      const arm = state.arms.find(a => a.id === proof.entry)!;
      if (!(yield* chain!({ entry: arm.id, root: arm.root, delegate: arm.delegate, proof, tipHash: snapshot.tipHash })))
        yield* checked(() => { revokeSupersession(state, proof); reconcile(state); });
    }
  });
}
export class Supersessions {
  private readonly c: RegistryContext;
  constructor(c: RegistryContext) { this.c = c; }
  private receipt(state: State, id: string) {
    const c = this.c;
    return Effect.gen(function* () {
      const proof = state.supersessions.filter(s => s.entry === id).at(-1);
      const exposed = proof ? Object.fromEntries(Object.entries(proof).filter(([key]) => key !== "originalRaw")) : null;
      yield* c.storage.flush();
      const position = yield* c.storage.status();
      const entry = state.entries.find(e => e.id === id)!;
      const unsafeMember = entry.bindings.some(b => !["issuing", "ready", "fulfilled"].includes(state.orders.find(o => o.id === b.id)!.status));
      return { entry: id, proof: exposed, conflicted: !proof?.active && (!usableEntry(state, id) || !!proof && unsafeMember),
        acknowledged: yield* c.storage.confirm(position.seq) };
    });
  }
  current(value: unknown) {
    const self = this, c = this.c;
    return Effect.gen(function* () {
      const input = yield* checked(() => armInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { state } = yield* c.refresh(); yield* checked(() => armed(state, input));
        return yield* self.receipt(state, input.id);
      }));
    });
  }
  accept(value: unknown) {
    const self = this, c = this.c;
    return Effect.gen(function* () {
      const input = yield* checked(() => supersessionInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { records, state, tipHash } = yield* c.refresh();
        yield* checked(() => armed(state, input));
        const previous = state.supersessions.filter(s => s.entry === input.id).at(-1);
        const retry = state.supersessions.find(s => s.entry === input.id && s.revision === input.proof.revision);
        if (retry) {
          yield* checked(() => { if (JSON.stringify({ ...retry, active: true }) !== JSON.stringify(input.proof)) fail("supersession proof identity is permanent; reobserve before another decision"); });
          return yield* self.receipt(state, input.id);
        }
        yield* checked(() => {
          if (previous && (previous.active || input.proof.revision <= previous.revision)) fail("fresh supersession requires a newer observation after revocation");
          const report = state.commitments.find(c => c.entry === input.id);
          if (!report || report.revision !== input.proof.revision || report.observation.txid !== input.proof.txid ||
              report.observation.minedHeight !== null || report.observation.tipHash !== tipHash || report.observation.tipHeight !== state.settings.tip ||
              input.proof.tipHash !== tipHash || input.proof.tipHeight !== state.settings.tip) fail("supersession observation changed; reobserve");
          const entry = state.entries.find(e => e.id === input.id)!;
          if (!c.supersessionChain || !usableEntry(state, input.id) || entry.bindings.some(b =>
              !["issuing", "ready", "fulfilled"].includes(state.orders.find(o => o.id === b.id)!.status)))
            fail("supersession verification unavailable or entry conflicted", "unavailable");
        });
        if (!(yield* c.supersessionChain!({ entry: input.id, root: input.root, delegate: input.delegate, proof: input.proof, tipHash: tipHash! })))
          return yield* checked(() => fail("conflict is not settled on this chain"));
        yield* checked(() => { applySupersession(state, input.proof); reconcile(state); });
        yield* c.save(records, state); return yield* self.receipt(state, input.id);
      }));
    });
  }
}
