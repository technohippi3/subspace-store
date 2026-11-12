import { Effect, type Semaphore } from "effect";
import { canonicalHandle } from "../recipient.ts";
import type { DurableStore, StorageError } from "../storage/store.ts";
import { checked, fail, type ApplicationError, type Record, type State } from "./records.ts";
import { entryOk, members, orderById, orderIds } from "./entry.ts";
import { reconcile } from "./monitor.ts";
import { BoundEntries } from "./bound-entries.ts";
import { Commitments } from "./commitments.ts";

type Result<A> = Effect.Effect<A, ApplicationError | StorageError>;
interface Loaded { records: readonly Record[]; state: State; tipHash?: string | undefined }
export interface RegistryContext {
  readonly storage: DurableStore;
  readonly queue: ReturnType<typeof Semaphore.makeUnsafe>;
  readonly load: () => Result<Loaded>;
  readonly refresh: () => Result<Loaded>;
  readonly save: (before: readonly Record[], state: State) => Result<void>;
}
/** Uses the application's existing queue and owner. It neither sends nor
 * establishes root/delegate/finality evidence; those belong to the controller. */
export class IssuanceRegistry {
  readonly entries: BoundEntries;
  readonly commitments: Commitments;
  private readonly context: RegistryContext;
  constructor(context: RegistryContext) { this.context = context; this.entries = new BoundEntries(context); this.commitments = new Commitments(context); }
  entry(id: string) {
    const c = this.context;
    return c.queue.withPermit(Effect.gen(function* () {
      const { state } = yield* c.refresh();
      return yield* checked(() => { const order = orderById(state, id);
        return { batch_entry: entryOk(state, order), issuing_recheck: entryOk(state, order, true) }; });
    }));
  }
  markIssuing(value: unknown) {
    const c = this.context;
    return Effect.gen(function* () {
      const ids = yield* checked(() => orderIds(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { records, state } = yield* c.refresh();
        yield* checked(() => {
          const orders = members(state, ids);
          if (orders.some(o => !entryOk(state, o))) fail("not batchable");
          // Validate every member before changing any member.
          for (const order of orders) order.status = "issuing";
          reconcile(state);
        });
        yield* c.save(records, state); yield* c.storage.flush();
        for (const id of ids) {
          const saved = yield* c.storage.acknowledged("sales_order", id);
          if (!saved || JSON.stringify(saved.value) !== JSON.stringify(orderById(state, id)) ||
              !(yield* c.storage.confirm(saved.seq))) return { acknowledged: [] as string[] };
        }
        return { acknowledged: ids };
      }));
    });
  }
  journal(id: string) {
    const c = this.context;
    return c.queue.withPermit(Effect.gen(function* () {
      const { state } = yield* c.load(), order = yield* checked(() => orderById(state, id));
      yield* c.storage.flush();
      const saved = yield* c.storage.acknowledged("sales_order", id);
      return { acknowledged: !!saved && JSON.stringify(saved.value) === JSON.stringify(order) &&
        (yield* c.storage.confirm(saved.seq)) };
    }));
  }
  setPending(value: unknown) {
    const c = this.context;
    return Effect.gen(function* () {
      const ids = yield* checked(() => orderIds(value, true));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { records, state } = yield* c.refresh();
        yield* checked(() => {
          if (members(state, ids).some(o => !entryOk(state, o))) fail("pending member is not batchable");
          state.pending = [...ids];
        });
        yield* c.save(records, state); yield* c.storage.flush();
        const saved = yield* c.storage.acknowledged("registry_pending", "global");
        return { acknowledged: !!saved && JSON.stringify(saved.value) === JSON.stringify({ version: 1, orders: ids }) &&
          (yield* c.storage.confirm(saved.seq)) };
      }));
    });
  }
  pendingFor(space: string) {
    const c = this.context;
    return c.queue.withPermit(Effect.gen(function* () {
      yield* checked(() => { if (typeof space !== "string" || !space.startsWith("@") || !canonicalHandle("probe" + space)) fail("invalid space", "invalid"); });
      const { state } = yield* c.load();
      const saved = yield* c.storage.acknowledged("registry_pending", "global");
      if (!saved || JSON.stringify(saved.value) !== JSON.stringify({ version: 1, orders: state.pending }) ||
          !(yield* c.storage.confirm(saved.seq))) return { handles: [] };
      return { handles: state.pending.map(id => orderById(state, id)).filter(o => "@" + o.space === space &&
        (entryOk(state, o) || entryOk(state, o, true))).sort((a, b) => a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0)
        .map(o => ({ handle: o.handle, script_pubkey: o.recipient })) };
    }));
  }
}
