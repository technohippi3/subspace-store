import { Effect } from "effect";
import type { BatchDatabase } from "./database.ts";
import { checked, refuse } from "./errors.ts";
import { latest, type ControllerJournal } from "./journal.ts";
import { batch, possibleSend, sameIdentity, type Batch } from "./records.ts";
import type { OrderBinding, Result } from "./ports.ts";
import type { PreparationPorts } from "./preparation-ports.ts";
import { orderBinding, successorDigest } from "./rebuild-records.ts";
import { PreparationBarrier } from "./preparation-history.ts";
import { PreparationReadback } from "./preparation-readback.ts";

/** Abort only fully completed staging ownership. Unknown requests never retry. */
export function abortPreparation(db: BatchDatabase, journal: ControllerJournal, ports: PreparationPorts, bid: string): Result<Batch> {
  return Effect.gen(function* () {
    const barrier = new PreparationBarrier(journal), reader = new PreparationReadback(ports);
    const b = yield* checked("check abort history", () => {
      const entries = journal.entries(); db.requireRestored(new Set(latest(entries).keys()));
      const b = db.get(bid), state = barrier.state(), prior = state.aborted.get(bid);
      const same = (r: { bid: string; space: string; members: string[]; digest: string }) =>
        r.bid === bid && r.space === b.space && r.digest === b.digest && r.members.join() === b.members.join();
      if (state.unresolved || state.owner && !same(state.owner) || prior && !same(prior) ||
          !state.owner && (!prior || state.latest.get(bid)?.phase !== "cleared"))
        refuse("abort requires exact completed ownership or acknowledged abort progress", "restore_required");
      const rows = [b, ...entries.filter(e => e.kind === "batch" && batch(e.batch).bid === bid).map(e => batch(e.batch))];
      if (rows.some(row => !sameIdentity(row, b) || possibleSend(row) || row.intent || row.root || row.entry_key || row.recovery_paused ||
          !["frozen", "staged", "rebuilt"].includes(row.state)) || entries.some(e => e.kind === "commit_local_intent" && e.bid === bid))
        refuse("commitment, foreign binding or send evidence; preparation abort refused");
      if (b.state === "rebuilt" && (!prior || b.release_failed !== JSON.stringify(b.members))) refuse("batch retired outside preparation abort");
      return b;
    });
    if (b.state === "rebuilt") {
      yield* checked("acknowledge completed abort", () => journal.append(b)); return b;
    }
    const inspect = () => Effect.gen(function* () {
      const bindings: OrderBinding[] = [];
      for (const oid of b.members) {
        const value = yield* ports.registry.inspect(oid);
        bindings.push(yield* checked("inspect abort binding", () => {
          const order = orderBinding(value, b, oid);
          if (!["requested", "quoted", "unpaid", "converted", "cancelled", "refund_due"].includes(order.status)) refuse("foreign issuance still owns preparation member");
          return order;
        }));
      }
      yield* checked("confirm abort digest", () => {
        if (new Set(bindings.map(o => o.name)).size !== bindings.length || successorDigest(bindings) !== b.digest) refuse("preparation abort frozen binding differs");
      });
      yield* reader.head(b); yield* reader.available(b, bindings);
    });
    yield* inspect();
    yield* checked("acknowledge preparation abort", () => {
      if (!barrier.state().aborted.has(bid)) journal.appendEvent("preparation_abort", {
        version: 1, bid, space: b.space, members: b.members, digest: b.digest });
      barrier.state();
    });
    if ((yield* checked("read current abort ownership", () => barrier.state())).owner) {
      const last = yield* checked("read completed abort clear", () => journal.entries().filter(e => e.kind === "preparation_effect" && e.bid === bid).at(-1));
      if (!(last?.operation === "pending_clear" && last.phase === "confirmed" && last.acknowledged === true)) {
        yield* checked("acknowledge abort pending-clear intent", () => { barrier.intent(b, "pending_clear", []); barrier.confirmIntent(b, "pending_clear", []); });
        const ack = yield* ports.registry.pending([]);
        yield* checked("acknowledge completed abort clear", () => { barrier.confirm(b, "pending_clear", [], ack); if (!ack) refuse("abort pending clear not acknowledged"); });
      }
      yield* checked("finish preparation ownership", () => barrier.finish(b));
    }
    yield* inspect();
    return yield* checked("retire aborted preparation", () => {
      const retired = db.patch(bid, { state: "rebuilt", release_failed: JSON.stringify(b.members) }); journal.append(retired); return retired;
    });
  });
}
