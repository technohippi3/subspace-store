import { Effect } from "effect";
import type { RegistryContext } from "./registry.ts";
import { checked, fail, type State } from "./records.ts";
import { armInput, entryInput, sameEntry, sameMarker, type EntryClosure, type EntryInput } from "./bound-records.ts";
import { entryOk, members, orderById } from "./entry.ts";
import { reconcile } from "./monitor.ts";
import { liveEntries, usableEntry } from "./supersession-records.ts";

/** A stable controller entry ID is bound atomically to its root and exact
 * immutable order bindings. Retrying it never allocates a second entry. */
export class BoundEntries {
  private readonly context: RegistryContext;
  constructor(context: RegistryContext) { this.context = context; }
  private receipt(state: State, input: EntryInput) {
    const c = this.context;
    return Effect.gen(function* () {
      yield* c.storage.flush();
      const closed = state.closures.find(m => m.id === input.id);
      if (closed) {
        yield* checked(() => sameMarker(closed, input));
        const saved = yield* c.storage.acknowledged("entry_closure", closed.id);
        return { found: true as const, entry: closed.id, root: closed.root, oids: [...closed.oids], phase: "closed" as const,
          acknowledged: !!saved && JSON.stringify(saved.value) === JSON.stringify(closed) && (yield* c.storage.confirm(saved.seq)),
          batchable: false, delegate: null };
      }
      const entry = state.entries.find(e => e.id === input.id)!;
      const armed = state.arms.find(m => m.id === input.id);
      const saved = yield* c.storage.acknowledged("issuance_entry", entry.id);
      let acknowledged = !!saved && JSON.stringify(saved.value) === JSON.stringify(entry) && (yield* c.storage.confirm(saved.seq));
      for (const b of entry.bindings) {
        if (!acknowledged) break;
        const order = yield* c.storage.acknowledged("sales_order", b.id);
        acknowledged = !!order && JSON.stringify(order.value) === JSON.stringify(orderById(state, b.id)) &&
          (yield* c.storage.confirm(order.seq));
      }
      if (armed && acknowledged) {
        const saved = yield* c.storage.acknowledged("entry_arm", armed.id);
        acknowledged = !!saved && JSON.stringify(saved.value) === JSON.stringify(armed) && (yield* c.storage.confirm(saved.seq));
      }
      return { found: true as const, entry: entry.id, root: entry.root, oids: entry.bindings.map(b => b.id), acknowledged,
        phase: armed ? "armed" as const : "open" as const, delegate: armed?.delegate ?? null,
        batchable: usableEntry(state, entry.id) && entry.bindings.every(b => entryOk(state, orderById(state, b.id), true)) };
    });
  }
  find(value: unknown) {
    const self = this, c = this.context;
    return Effect.gen(function* () {
      const input = yield* checked(() => entryInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { state } = yield* c.refresh(), entry = state.entries.find(e => e.id === input.id);
        if (!entry && !state.closures.some(m => m.id === input.id)) return { found: false as const };
        if (entry) yield* checked(() => sameEntry(entry, input));
        return yield* self.receipt(state, input);
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
          const closed = state.closures.find(m => m.id === input.id);
          if (closed) { sameMarker(closed, input); return; }
          if (entry) { sameEntry(entry, input); return; }
          const orders = members(state, input.ids);
          if (orders.some(o => !entryOk(state, o))) fail("not batchable");
          entry = { version: 1, id: input.id, root: input.root,
            bindings: orders.map(o => ({ id: o.id, handle: o.handle, recipient: o.recipient })) };
          for (const order of orders) order.status = "issuing";
          state.entries.push(entry); reconcile(state);
        });
        yield* c.save(records, state);
        return yield* self.receipt(state, input);
      }));
    });
  }
  close(value: unknown) {
    const self = this, c = this.context;
    return Effect.gen(function* () {
      const input = yield* checked(() => entryInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { records, state } = yield* c.refresh();
        yield* checked(() => {
          const old = state.closures.find(m => m.id === input.id);
          if (old) { sameMarker(old, input); return; }
          const entry = state.entries.find(e => e.id === input.id);
          if (entry) sameEntry(entry, input);
          if (state.arms.some(m => m.id === input.id)) fail("entry is armed; unsent release refused");
          const orders = members(state, input.ids);
          if (entry) {
            for (const order of orders) order.status = liveEntries(state, order.id).some(e => e.id !== input.id) ? "issuing" : "converted";
            state.pending = state.pending.filter(id => !input.ids.includes(id));
          }
          const closed: EntryClosure = { version: 1, id: input.id, root: input.root, oids: [...input.ids] };
          state.closures.push(closed); reconcile(state);
        });
        yield* c.save(records, state);
        return yield* self.receipt(state, input);
      }));
    });
  }
  arm(value: unknown) {
    const self = this, c = this.context;
    return Effect.gen(function* () {
      const input = yield* checked(() => armInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { records, state } = yield* c.refresh();
        const entry = yield* checked(() => {
          if (state.closures.some(m => m.id === input.id)) fail("entry is closed; broadcast refused");
          const entry = state.entries.find(e => e.id === input.id) ?? fail("entry is missing"); sameEntry(entry, input);
          return entry;
        });
        const previous = state.arms.find(m => m.id === input.id);
        if (previous) {
          yield* checked(() => { if (previous.delegate !== input.delegate) fail("entry is armed for another delegate"); });
          return { ...(yield* self.receipt(state, input)), granted: false };
        }
        const before = yield* self.receipt(state, input);
        yield* checked(() => {
          if (state.arms.some(a => a.id !== input.id && a.delegate === input.delegate &&
              !state.supersessions.some(s => s.entry === a.id && s.active))) fail("delegate already has an attempted commitment");
          if (!before.acknowledged || !entry.bindings.every(b => entryOk(state, orderById(state, b.id), true))) fail("entry not confirmed and batchable");
          state.arms.push({ version: 1, id: input.id, root: input.root, oids: [...input.ids], delegate: input.delegate });
        });
        yield* c.save(records, state);
        const receipt = yield* self.receipt(state, input);
        return { ...receipt, granted: receipt.acknowledged };
      }));
    });
  }
}
