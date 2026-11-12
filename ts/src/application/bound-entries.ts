import { Effect } from "effect";
import type { RegistryContext } from "./registry.ts";
import { checked, fail, type State } from "./records.ts";
import { entryInput, sameEntry, type BoundEntry } from "./bound-records.ts";
import { entryOk, members, orderById } from "./entry.ts";
import { reconcile } from "./monitor.ts";

/** A stable controller entry ID is bound atomically to its root and exact
 * immutable order bindings. Retrying it never allocates a second entry. */
export class BoundEntries {
  private readonly context: RegistryContext;
  constructor(context: RegistryContext) { this.context = context; }
  private receipt(state: State, entry: BoundEntry) {
    const c = this.context;
    return Effect.gen(function* () {
      yield* c.storage.flush();
      const saved = yield* c.storage.acknowledged("issuance_entry", entry.id);
      let acknowledged = !!saved && JSON.stringify(saved.value) === JSON.stringify(entry) && (yield* c.storage.confirm(saved.seq));
      for (const b of entry.bindings) {
        if (!acknowledged) break;
        const order = yield* c.storage.acknowledged("sales_order", b.id);
        acknowledged = !!order && JSON.stringify(order.value) === JSON.stringify(orderById(state, b.id)) &&
          (yield* c.storage.confirm(order.seq));
      }
      return { found: true as const, entry: entry.id, root: entry.root, oids: entry.bindings.map(b => b.id), acknowledged,
        batchable: entry.bindings.every(b => entryOk(state, orderById(state, b.id), true)) };
    });
  }
  find(value: unknown) {
    const self = this, c = this.context;
    return Effect.gen(function* () {
      const input = yield* checked(() => entryInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { state } = yield* c.refresh(), entry = state.entries.find(e => e.id === input.id);
        if (!entry) return { found: false as const };
        yield* checked(() => sameEntry(entry, input));
        return yield* self.receipt(state, entry);
      }));
    });
  }
  enter(value: unknown) {
    const self = this, c = this.context;
    return Effect.gen(function* () {
      const input = yield* checked(() => entryInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { records, state } = yield* c.refresh();
        let entry = state.entries.find(e => e.id === input.id);
        yield* checked(() => {
          if (entry) { sameEntry(entry, input); return; }
          const orders = members(state, input.ids);
          if (orders.some(o => !entryOk(state, o))) fail("not batchable");
          entry = { version: 1, id: input.id, root: input.root,
            bindings: orders.map(o => ({ id: o.id, handle: o.handle, recipient: o.recipient })) };
          for (const order of orders) order.status = "issuing";
          state.entries.push(entry); reconcile(state);
        });
        yield* c.save(records, state);
        return yield* self.receipt(state, entry!);
      }));
    });
  }
}
