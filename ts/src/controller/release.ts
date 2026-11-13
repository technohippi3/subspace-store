import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { BatchDatabase } from "./database.ts";
import { checked, ControllerError, refuse } from "./errors.ts";
import { latest, type ControllerJournal } from "./journal.ts";
import type { ControllerPorts, Lookup, OrderBinding, Result } from "./ports.ts";
import { batch, failedMembers, possibleSend, sameIdentity, type Batch } from "./records.ts";
import { failedSet, nativeHandle, orderBinding, successorDigest } from "./rebuild-records.ts";
import type { RebuildPolicy } from "./rebuild-policy.ts";
import { appendIfAvailable, settleRestart } from "./restart.ts";
import { entryReceipt } from "./registry-client.ts";
import { ISSUED } from "../order.ts";
import { preparationHistory, requirePreparationIdle } from "./preparation-history.ts";
import { PreparationReadback } from "./preparation-readback.ts";
import { upgradeAbortHistory } from "./journal-protocol.ts";

/** Known-unsent close/rebuild only; a child remains frozen for a later preparer. */
export class KnownUnsentRelease {
  private readonly db: BatchDatabase;
  private readonly journal: ControllerJournal;
  private readonly ports: ControllerPorts;
  private readonly policy: RebuildPolicy;
  constructor(db: BatchDatabase, journal: ControllerJournal, ports: ControllerPorts, policy: RebuildPolicy) {
    this.db = db; this.journal = journal; this.ports = ports; this.policy = policy;
  }
  private ready(bid: string): Result<Batch> {
    return checked("check known-unsent history", () => {
      upgradeAbortHistory(this.journal);
      requirePreparationIdle(this.journal);
      if (preparationHistory(this.journal.entries()).aborted.has(bid)) refuse("preparation was aborted; only abort completion may resume", "restore_required");
      // An outage refuses before any local progress or stale journal append.
      const entries = this.journal.entries(); this.db.requireRestored(new Set(latest(entries).keys()));
      settleRestart(this.db, this.journal);
      const b = this.db.get(bid), acknowledged = latest(entries).get(bid);
      if (possibleSend(b) || acknowledged && possibleSend(acknowledged) || entries.some(event => event.kind === "batch" &&
          batch(event.batch).bid === bid && possibleSend(batch(event.batch))))
        refuse("batch or journal records a possible send; unsent release refused");
      if (acknowledged && (!sameIdentity(b, acknowledged) || acknowledged.entry_key && acknowledged.entry_key !== b.entry_key))
        refuse("release identity differs from journal; reconcile before continuing");
      return b;
    });
  }
  private acknowledge(bid: string): Result<void> {
    return this.ready(bid).pipe(Effect.flatMap(b => checked("acknowledge release progress", () => this.journal.append(b))));
  }
  private bindings(b: Batch, ids = b.members, requireUnsent = true): Result<OrderBinding[]> {
    const self = this; return Effect.gen(function* () {
      const result: OrderBinding[] = [];
      for (const id of ids) {
        const value = yield* self.ports.registry.order(b, id);
        result.push(yield* checked("validate rebuild binding", () => {
          const binding = orderBinding(value, b, id);
          if (requireUnsent && ISSUED.includes(binding.status)) refuse("foreign issuance still owns release member; native changes withheld");
          return binding;
        }));
      }
      return result;
    });
  }
  private refuseArmed(b: Batch, receipt: Lookup): Result<void> {
    return checked("inspect armed release entry", () => {
      const entry = entryReceipt(receipt, b, true);
      if (entry.found && entry.phase === "armed") {
        const value = this.db.uncertain(b.bid, "store entry already armed", "unsent close refused: entry can have escaped", entry.delegate!);
        appendIfAvailable(this.journal, value); refuse("store entry already armed; release outcome uncertain");
      }
    });
  }
  private closed(b: Batch): Result<void> {
    const self = this; return Effect.gen(function* () {
      const raw = yield* self.ports.registry.lookup(b); yield* self.refuseArmed(b, raw);
      yield* checked("confirm live closure", () => {
        const value = entryReceipt(raw, b, true);
        if (!value.found || value.phase !== "closed" || !value.acknowledged) refuse("closed entry not currently acknowledged; rollback withheld");
      });
    });
  }
  release(bid: string, failed: readonly string[], bindingFailure = false): Result<string | null> {
    const self = this; return Effect.gen(function* () {
      let b = yield* self.ready(bid);
      const requested = yield* checked("validate failed members", () => failedSet(b, failed));
      if (["releasing", "rebuilding", "rebuilt"].includes(b.state) && b.release_failed !== null) {
        yield* checked("validate repeated release", () => {
          if (requested.some(id => !failedMembers(b).includes(id))) refuse("release already records a different failed-member set");
        });
        return yield* self.resume(bid);
      }
      yield* checked("validate release phase", () => {
        if (!["frozen", "staged", "committed_local", "proved", "checkpointed", "issuing"].includes(b.state) || b.recovery_paused)
          refuse("batch is not available for known-unsent release");
        if (b.root && !self.ports.release) refuse("native release ports are not configured", "unavailable");
        if (!b.root && (b.entry_key || b.intent || !["frozen", "staged"].includes(b.state) ||
            self.journal.entries().some(event => event.kind === "commit_local_intent" && event.bid === bid)))
          refuse("local commit outcome has no confirmed root; reconciliation required");
      });
      if (!b.root) {
        const ports = yield* checked("require precommit native readback", () => self.ports.preparation ?? refuse("precommit native readback is not configured", "unavailable"));
        const readback = new PreparationReadback(ports), bindings = yield* self.bindings(b);
        yield* readback.head(b); yield* readback.available(b, bindings);
        if (bindingFailure) yield* self.policy.note(bid);
        return yield* self.complete(b, requested);
      }
      if (bindingFailure) yield* self.policy.note(bid);
      b = yield* checked("persist release intent", () => self.db.patch(bid, {
        entry_key: b.entry_key ?? randomUUID().replaceAll("-", ""), state: "releasing", release_failed: JSON.stringify(requested) }));
      return yield* self.resume(b.bid);
    });
  }
  resume(bid: string): Result<string | null> {
    const self = this; return Effect.gen(function* () {
      let b = yield* self.ready(bid);
      if (b.state === "rebuilt" && b.release_failed !== null) return yield* self.successor(b);
      yield* checked("validate release resume", () => {
        if (!["releasing", "rebuilding"].includes(b.state) || b.release_failed === null || !b.root || !b.entry_key)
          refuse("no known-unsent release to resume");
        if (!self.ports.release) refuse("native release ports are not configured", "unavailable");
      });
      yield* self.acknowledge(bid);
      if (b.state === "releasing") {
        yield* self.ready(bid);
        const result = yield* self.ports.registry.close(b).pipe(Effect.matchCause({
          onSuccess: value => ({ ok: true as const, value }), onFailure: () => ({ ok: false as const }) }));
        if (!result.ok) {
          const entry = yield* self.ports.registry.lookup(b);
          yield* self.refuseArmed(b, entry);
          return yield* Effect.fail(new ControllerError({ code: "unavailable", message: "entry close has no confirmed answer; rollback withheld" }));
        }
        yield* self.refuseArmed(b, result.value);
        yield* checked("confirm closed receipt", () => {
          const value = entryReceipt(result.value, b);
          if (!value.found || value.phase !== "closed" || !value.acknowledged) refuse("entry closure not acknowledged; rollback withheld");
        });
        b = yield* checked("persist closed progress", () => self.db.patch(bid, { state: "rebuilding", intent: 0 }));
        yield* self.acknowledge(bid);
      } else yield* self.closed(b);
      let bindings = yield* self.bindings(b); yield* self.rollback(b, bindings);
      b = self.db.get(bid);
      const failed = [...new Set([...failedMembers(b), ...(yield* self.ports.registry.failing(b, false))])].sort();
      yield* checked("validate growing exclusions", () => failedSet(b, failed));
      if (JSON.stringify(failed) !== b.release_failed) {
        b = yield* checked("persist growing exclusions", () => self.db.patch(bid, { release_failed: JSON.stringify(failed) }));
        yield* self.acknowledge(bid);
      }
      bindings = yield* self.bindings(b);
      yield* self.closed(b); yield* self.ready(bid);
      if (failed.length) yield* self.ports.release!.park(b.space, bindings.filter(order => failed.includes(order.oid)).map(order => order.name.split("@")[0]!));
      for (const order of bindings) {
        const info = yield* self.ports.release!.handle(b.space, order.name.split("@")[0]!);
        yield* checked("confirm parked rebuild members", () => {
          const current = nativeHandle(info, order);
          if (current.commitment_root !== null || current.parked !== failed.includes(order.oid)) refuse("parked rebuild membership differs; successor withheld");
        });
      }
      return yield* self.complete(b, failed);
    });
  }
  private rollback(b: Batch, bindings: readonly OrderBinding[]): Result<void> {
    const self = this, ports = self.ports.release!;
    const roots = () => Effect.gen(function* () {
      const values: (string | null)[] = [];
      for (const order of bindings) {
        const value = yield* ports.handle(b.space, order.name.split("@")[0]!);
        values.push((yield* checked("read exact rebuild root", () => nativeHandle(value, order))).commitment_root);
      }
      return values;
    });
    return Effect.gen(function* () {
      yield* self.ready(b.bid);
      let current = yield* roots();
      if (current.every(root => root === b.root)) {
        yield* checked("acknowledge rollback intent", () => self.journal.appendEvent("entry_rollback_intent", { bid: b.bid, root: b.root, entry_key: b.entry_key }));
        yield* self.bindings(b);
        current = yield* roots();
        yield* self.ready(b.bid); yield* self.closed(b); yield* self.ready(b.bid);
        if (current.every(root => root === b.root)) { yield* ports.rollback(b.space); current = yield* roots(); }
      }
      yield* checked("confirm local rollback", () => { if (current.some(root => root !== null)) refuse("mixed or foreign rebuild roots; rollback withheld"); });
    });
  }
  private complete(b: Batch, failed: readonly string[]): Result<string | null> {
    const self = this; return Effect.gen(function* () {
      const all = yield* self.bindings(b), bindings = all.filter(order => !failed.includes(order.oid));
      yield* checked("retire parent and create sole successor", () => self.db.completeRebuild(b.bid, failed, successorDigest(bindings), self.policy.paused(b.bid)));
      return yield* self.successor(self.db.get(b.bid));
    });
  }
  private successor(b: Batch): Result<string | null> {
    const self = this; return Effect.gen(function* () {
      const children = self.db.batches().filter(child => child.supersedes === b.bid);
      if (yield* checked("read historical rebuild pause", () => self.policy.paused(b.bid))) {
        yield* checked("validate paused parent", () => { if (children.length) refuse("paused rebuild unexpectedly has a successor"); });
        yield* self.acknowledge(b.bid);
        return yield* checked("retain historical rebuild pause", () => refuse("three rebuilds in a row: paused parent cannot acquire a successor"));
      }
      const keep = b.members.filter(id => !failedMembers(b).includes(id)), bindings = yield* self.bindings(b, keep, false);
      yield* checked("validate sole rebuild successor", () => {
        const child = children[0];
        if (children.length !== (keep.length ? 1 : 0) || child && (child.members.join() !== keep.join() || child.space !== b.space ||
            child.prior_root !== b.prior_root || child.digest !== successorDigest(bindings))) refuse("rebuild successor differs; reconciliation required");
      });
      if (children[0]) yield* checked("acknowledge sole successor", () => {
        const child = self.db.get(children[0]!.bid), acked = latest(self.journal.entries()).get(child.bid);
        if (acked && Object.entries(child).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(acked[key as keyof Batch])))
          refuse("successor journal differs; reconciliation required before completion");
        self.journal.append(child);
      });
      yield* self.acknowledge(b.bid); return children[0]?.bid ?? null;
    });
  }
}
