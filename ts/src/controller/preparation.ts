import { Effect } from "effect";
import { canonicalHandle } from "../recipient.ts";
import type { BatchDatabase } from "./database.ts";
import { checked, refuse } from "./errors.ts";
import { latest, type ControllerJournal } from "./journal.ts";
import { orderBinding, successorDigest } from "./rebuild-records.ts";
import type { RebuildPolicy } from "./rebuild-policy.ts";
import { hash, orderIds, possibleSend, type Batch } from "./records.ts";
import type { OrderBinding, Result } from "./ports.ts";
import type { PreparationPorts } from "./preparation-ports.ts";
import { PreparationBarrier, requirePreparationIdle, type PreparationOperation } from "./preparation-history.ts";
import { PreparationReadback } from "./preparation-readback.ts";
import { count, object, syncFact } from "./preparation-facts.ts";
import { settleRestart } from "./restart.ts";

/** Stops at committed_local. No proving/checkpoint transition or native setup. */
export class BatchPreparation {
  private readonly db: BatchDatabase;
  private readonly journal: ControllerJournal;
  private readonly policy: RebuildPolicy;
  private readonly configured: PreparationPorts | undefined;
  private readonly barrier: PreparationBarrier;
  constructor(db: BatchDatabase, journal: ControllerJournal, policy: RebuildPolicy, ports: PreparationPorts | undefined) {
    this.db = db; this.journal = journal; this.policy = policy; this.configured = ports; this.barrier = new PreparationBarrier(journal);
  }
  private ports(): PreparationPorts { return this.configured ?? refuse("preparation ports are not configured", "unavailable"); }
  private ready(bid?: string): void {
    const entries = this.journal.entries(); this.db.requireRestored(new Set(latest(entries).keys()));
    requirePreparationIdle(this.journal, bid); settleRestart(this.db, this.journal);
  }
  private bindings(b: Batch): Result<OrderBinding[]> {
    const self = this; return Effect.gen(function* () {
      const ports = yield* checked("read preparation ports", () => self.ports()), result: OrderBinding[] = [];
      for (const id of b.members) {
        const value = yield* ports.registry.inspect(id);
        const binding = yield* checked("validate immutable preparation binding", () => orderBinding(value, b, id));
        if (binding.status !== "converted" || !(yield* ports.registry.batchable(id)))
          return yield* checked("require eligible preparation member", () => refuse("preparation member is no longer converted and batchable"));
        result.push(binding);
      }
      yield* checked("confirm immutable preparation digest", () => {
        if (new Set(result.map(order => order.name)).size !== result.length || successorDigest(result) !== b.digest)
          refuse("frozen preparation digest or distinct handle bindings differ");
      });
      return result;
    });
  }
  private noCommit(b: Batch): void {
    if (possibleSend(b) || b.intent || b.root || b.entry_key || b.recovery_paused ||
        this.journal.entries().some(event => event.kind === "commit_local_intent" && event.bid === b.bid))
      refuse("local commitment already requested or ambiguous; reconciliation required", "restore_required");
  }
  private effect<A>(b: Batch, operation: PreparationOperation, labels: readonly string[], work: () => Result<A>, acknowledgment: (value: A) => boolean | null = () => null): Result<A> {
    const self = this; return Effect.gen(function* () {
      yield* checked("acknowledge preparation effect intent", () => { self.ready(b.bid); self.barrier.intent(b, operation, labels); });
      yield* checked("confirm live one-use preparation intent", () => self.barrier.confirmIntent(b, operation, labels));
      const value = yield* work();
      yield* checked("acknowledge completed preparation response", () => self.barrier.confirm(b, operation, labels, acknowledgment(value)));
      return value;
    });
  }
  freeze(space: string, requested?: readonly string[]): Result<Batch> {
    const self = this; return Effect.gen(function* () {
      const ports = yield* checked("validate freeze admission", () => {
        self.ready(); if (!canonicalHandle("probe" + space)) refuse("invalid preparation space", "invalid");
        if (requested !== undefined) { orderIds([...requested].sort()); if (requested.length > 1000) refuse("preparation API membership exceeds limit", "invalid"); }
        return self.ports();
      });
      yield* self.policy.requireGate();
      const all = self.db.batches(), open = all.filter(b => !["rebuilt", "final", "fulfilled", "superseded"].includes(b.state));
      yield* checked("require one open preparation batch", () => { if (open.some(b => b.space === space)) refuse("another batch is open for this space"); });
      const busy = new Set(open.flatMap(b => b.members)), ids = yield* ports.registry.converted();
      const selected: OrderBinding[] = [];
      for (const id of ids) {
        if (busy.has(id) || requested !== undefined && !requested.includes(id)) continue;
        const binding = yield* ports.registry.inspect(id);
        if (binding.status === "converted" && binding.name.endsWith(space) && (yield* ports.registry.batchable(id))) selected.push(binding);
      }
      yield* checked("validate selected preparation members", () => {
        if (!selected.length || selected.length > 1000 || new Set(selected.map(order => order.name)).size !== selected.length || requested !== undefined && selected.length !== requested.length)
          refuse("requested preparation members are unavailable, ineligible or empty");
      });
      const prior = yield* ports.chainRoot(space);
      const b = yield* checked("freeze immutable preparation batch", () => {
        self.ready(); if (prior !== null && !hash(prior)) refuse("invalid observed preparation prior root", "invalid");
        return self.db.freeze(space, selected.map(order => order.oid).sort(), successorDigest(selected), prior);
      });
      yield* checked("acknowledge frozen batch", () => self.journal.append(b)); return b;
    });
  }
  stage(bid: string): Result<Batch> {
    const self = this; return Effect.gen(function* () {
      const ports = yield* checked("validate stage admission", () => { self.ready(bid); return self.ports(); });
      yield* self.policy.requireGate(); const b = self.db.get(bid), readback = new PreparationReadback(ports);
      yield* checked("validate preparation stage", () => {
        if (!["frozen", "staged"].includes(b.state)) refuse("batch is not frozen or staged"); self.noCommit(b);
      });
      let bindings = yield* self.bindings(b); yield* checked("acknowledge stage identity", () => self.journal.append(b));
      yield* readback.head(b);
      if (b.state === "staged" || self.barrier.state().latest.get(bid)?.phase === "cleared") {
        yield* readback.exact(b, bindings);
        if (b.state === "staged") return b;
        const staged = yield* checked("record completed stage after clear", () => self.db.patch(bid, { state: "staged" }));
        yield* checked("acknowledge completed stage", () => self.journal.append(staged)); return staged;
      }
      yield* readback.available(b, bindings);
      let staged = yield* readback.staged(b.space);
      yield* checked("validate existing staged bindings", () => {
        if (staged.some(h => bindings.some(o => o.name.split("@")[0] === h.name && o.recipient_spk !== h.script_pubkey)))
          refuse("preexisting staged script differs from frozen member");
      });
      yield* checked("acquire global pending ownership", () => self.barrier.acquire(b));
      const acknowledged = yield* self.effect(b, "pending_set", [], () => ports.registry.pending(b.members), value => value);
      yield* checked("require pending acknowledgment", () => { if (!acknowledged) refuse("pending preparation set not acknowledged; native sync withheld"); });
      bindings = yield* self.bindings(b); yield* readback.head(b);
      // A previously staged exact set needs no sync. Any actual sync receives a
      // durable one-request barrier; an absent reply cannot be repaired by readback.
      staged = yield* readback.staged(b.space);
      const expected = new Map(bindings.map(order => [order.name.split("@")[0]!, order.recipient_spk]));
      if (!bindings.every(order => staged.some(h => h.name === order.name.split("@")[0] && h.script_pubkey === order.recipient_spk))) {
        yield* self.effect(b, "sync", [], () => ports.native.sync().pipe(Effect.flatMap(raw => checked("validate completed sync response", () => syncFact(raw)))));
        staged = yield* readback.staged(b.space);
      }
      const strays = staged.filter(h => !h.parked && !expected.has(h.name)).map(h => h.name).sort();
      const unpark = staged.filter(h => h.parked && expected.has(h.name)).map(h => h.name).sort();
      for (const [operation, labels, parked] of [["park", strays, true], ["unpark", unpark, false]] as const) if (labels.length) {
        yield* self.bindings(b); yield* readback.head(b);
        yield* self.effect(b, operation, labels, () => ports.native.park(b.space, labels, parked).pipe(Effect.flatMap(raw => checked("validate completed parking response", () => {
          const row = object(raw, "updated"); if (Object.keys(row).join() !== "updated" || !count(row.updated) || row.updated > labels.length) refuse("invalid preparation parking response", "invalid");
        }))));
      }
      bindings = yield* self.bindings(b); yield* readback.head(b); yield* readback.exact(b, bindings);
      const clear = yield* self.effect(b, "pending_clear", [], () => ports.registry.pending([]), value => value);
      yield* checked("require pending clear acknowledgment", () => { if (!clear) refuse("pending preparation clear not acknowledged; staged transition withheld"); });
      yield* checked("acknowledge released global pending ownership", () => self.barrier.finish(b));
      const complete = yield* checked("record exact staged preparation", () => self.db.patch(bid, { state: "staged" }));
      yield* checked("acknowledge staged preparation", () => self.journal.append(complete)); return complete;
    });
  }
  commit(bid: string): Result<Batch> {
    const self = this; return Effect.gen(function* () {
      const ports = yield* checked("validate local commit admission", () => { self.ready(); return self.ports(); });
      yield* self.policy.requireGate(); const b = self.db.get(bid), readback = new PreparationReadback(ports), bindings = yield* self.bindings(b);
      if (b.state === "committed_local" && b.root) { yield* readback.committed(b, bindings, b.root); return b; }
      yield* checked("require unrequested local commit", () => { if (b.state !== "staged") refuse("batch is not staged"); self.noCommit(b); });
      yield* readback.head(b); yield* readback.exact(b, bindings); yield* self.bindings(b);
      const existing = yield* readback.list(b.space, "committed");
      yield* checked("admit bounded committed readback capacity", () => {
        if (existing.length + b.members.length > 10_000) refuse("committed preparation readback capacity exceeded; no local commit");
      });
      yield* checked("acknowledge local commit intent", () => {
        self.ready(); self.noCommit(self.db.get(bid)); self.journal.append(b);
        self.journal.appendEvent("commit_local_intent", { bid, space: b.space });
      });
      yield* checked("confirm live local commit intent", () => { self.journal.entries(); requirePreparationIdle(self.journal); });
      const raw = yield* ports.native.commit(b.space), root = yield* readback.response(raw, b);
      yield* readback.committed(b, bindings, root); yield* self.bindings(b);
      const complete = yield* checked("record verified local commitment", () => self.db.patch(bid, { state: "committed_local", root }));
      yield* checked("acknowledge local commitment", () => self.journal.append(complete)); return complete;
    });
  }
}
