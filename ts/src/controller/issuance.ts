import { randomUUID } from "node:crypto";
import { Effect, Semaphore } from "effect";
import { BatchDatabase } from "./database.ts";
import { checked, ControllerError, refuse } from "./errors.ts";
import { latest, type ControllerJournal } from "./journal.ts";
import type { ControllerPorts, EntryReceipt, Lookup, Result } from "./ports.ts";
import { entryReceipt } from "./registry-client.ts";
import { hash, outpoint, sameIdentity, sameIntent, type Batch } from "./records.ts";
import { appendIfAvailable, settleRestart } from "./restart.ts";
import { strictJson } from "./json.ts";

export interface ControllerConfig { readonly database: string; readonly makeJournal: () => ControllerJournal }
function bounded(text: string): string {
  const characters = [...text]; return characters.length <= 2000 ? text : `${characters.slice(0, 2000).join("")} [cut: ${characters.length} characters in all]`;
}
/** Development kernel for a preexisting checkpointed bound batch. No native setup,
 * close/rebuild, polling, readback, deployment or runner selection is supplied. */
export class BoundController {
  private readonly db: BatchDatabase;
  private readonly journal: ControllerJournal;
  private readonly ports: ControllerPorts;
  private readonly queue = Semaphore.makeUnsafe(1);
  private constructor(config: ControllerConfig, ports: ControllerPorts) {
    const db = new BatchDatabase(config.database);
    try {
      // The factory and startup replay run only while lifetime flock is held.
      this.journal = config.makeJournal(); settleRestart(db, this.journal);
      this.db = db; this.ports = ports;
    } catch (error) { db.close(); throw error; }
  }
  static open(config: ControllerConfig, ports: ControllerPorts) {
    return Effect.acquireRelease(checked("open", () => new BoundController(config, ports)), controller => Effect.sync(() => controller.db.close()));
  }
  batch(bid: string): Result<Batch> { return checked("read batch", () => this.db.get(bid)); }
  alerts() { return checked("read alerts", () => this.db.alerts()); }
  private readJournal() {
    return checked("journal read", () => {
      const current = latest(this.journal.entries()); this.db.requireRestored(new Set(current.keys()));
      return current;
    });
  }
  private acknowledge(bid: string) { return checked("journal append", () => this.journal.append(this.db.get(bid))); }
  private uncertain(bid: string, answer: string, reason: string) {
    return checked("record uncertain attempt", () => {
      const value = this.db.uncertain(bid, bounded(answer), reason); appendIfAvailable(this.journal, value); return value;
    });
  }
  private usable(b: Batch, value: Lookup): EntryReceipt {
    const entry = entryReceipt(value, b, true);
    if (!entry.found || !entry.acknowledged) refuse("controller entry is not live and acknowledged; locks retained");
    if (entry.phase === "closed" || !entry.batchable) refuse("controller entry requires known-unsent release; locks retained", "release_required");
    if (entry.phase !== "open") refuse("controller entry is already armed; not sent");
    return entry;
  }
  private armed(b: Batch, value: Lookup): Result<void> {
    const self = this; return Effect.gen(function* () {
      const entry = yield* checked("validate entry", () => entryReceipt(value, b, true));
      if (entry.found && entry.phase === "armed") {
        yield* checked("retain armed entry", () => self.db.patch(b.bid, { state: "issuing", intent: 1, attempted: 1, delegate_in: entry.delegate }));
        yield* self.uncertain(b.bid, "entry was already armed", "local attempted-send evidence is stale");
        return yield* Effect.fail(new ControllerError({ code: "refused", message: "entry already armed; outcome uncertain, not sent" }));
      }
    });
  }
  issue(bid: string, feeRate = 1): Result<Batch> {
    const self = this; return self.queue.withPermit(Effect.gen(function* () {
      const current = yield* self.readJournal(); let b = yield* self.batch(bid);
      yield* checked("validate checkpoint", () => {
        if (b.state !== "checkpointed" || b.intent || b.attempted || b.recovery_paused || !b.root) refuse("batch is not an available checkpoint");
        if (!Number.isFinite(feeRate) || feeRate <= 0) refuse("invalid controller fee rate", "invalid");
        const acked = current.get(bid);
        if (acked && (!sameIdentity(b, acked) || acked.intent || acked.attempted || acked.entry_key && b.entry_key !== acked.entry_key))
          refuse("controller checkpoint differs from live journal; reopen and reconcile");
      });
      if (!b.entry_key) {
        const failed = yield* self.ports.registry.failing(b, false);
        if (failed.length) return yield* Effect.fail(new ControllerError({ code: "release_required", message: "batch member failed; known-unsent rebuild required" }));
        b = yield* checked("persist entry identity", () => self.db.patch(bid, { entry_key: randomUUID().replaceAll("-", "") }));
      }
      // No lookup or creation can occur until the identity has durable readback.
      yield* self.acknowledge(bid);
      let entry = yield* self.ports.registry.lookup(b);
      if (!entry.found) {
        if ((yield* self.ports.registry.failing(b, false)).length)
          return yield* Effect.fail(new ControllerError({ code: "release_required", message: "batch member failed; entry locks retained" }));
        entry = yield* self.ports.registry.enter(b);
      }
      yield* self.armed(b, entry); yield* checked("confirm entry", () => self.usable(b, entry));
      const delegate = yield* self.ports.delegate(b.space);
      b = yield* checked("persist issuance intent", () => {
        if (!outpoint(delegate)) refuse("invalid live controller delegate", "invalid");
        return self.db.patch(bid, { state: "issuing", intent: 1, delegate_in: delegate, fee_rate: feeRate });
      });
      yield* self.acknowledge(bid); return yield* self.sendFirst(b.bid);
    }));
  }
  resume(bid: string): Result<Batch> {
    const self = this; return self.queue.withPermit(Effect.gen(function* () {
      yield* self.readJournal(); let b = yield* self.batch(bid);
      yield* checked("validate resume", () => {
        if (b.state !== "issuing" || b.attempted || !b.entry_key || b.fee_rate === null || b.recovery_paused)
          refuse("no unattempted controller intent to resume");
      });
      const entry = yield* self.ports.registry.lookup(b); yield* self.armed(b, entry);
      yield* checked("confirm entry", () => self.usable(b, entry));
      if ((yield* self.ports.registry.failing(b, true)).length)
        return yield* Effect.fail(new ControllerError({ code: "release_required", message: "issuing member failed; known-unsent release required" }));
      const delegate = yield* self.ports.delegate(b.space);
      b = yield* checked("refresh issuance intent", () => {
        if (!outpoint(delegate)) refuse("invalid live controller delegate", "invalid");
        return self.db.patch(bid, { intent: 1, delegate_in: delegate });
      });
      yield* self.acknowledge(bid); return yield* self.sendFirst(b.bid);
    }));
  }
  /** Explicit internal send boundary also refuses every second attempt. */
  send(bid: string): Result<Batch> { return this.queue.withPermit(this.sendFirst(bid)); }
  private guard(b: Batch): Result<void> {
    const self = this; return Effect.gen(function* () {
      const acknowledged = (yield* self.readJournal()).get(b.bid);
      yield* checked("confirm controller intent", () => {
        if (!acknowledged || acknowledged.state !== "issuing" || !sameIntent(b, acknowledged)) refuse("controller intent is not live and acknowledged; not sent");
      });
      const raw = yield* self.ports.registry.lookup(b);
      yield* checked("confirm live store locks", () => {
        const entry = entryReceipt(raw, b, true);
        if (!entry.found || !entry.acknowledged || (!b.attempted ? entry.phase !== "open" || !entry.batchable :
          entry.phase !== "armed" || entry.delegate !== b.delegate_in)) refuse("store locks or arm not live and acknowledged; not sent");
      });
    });
  }
  private sendFirst(bid: string): Result<Batch> {
    const self = this; return Effect.gen(function* () {
      let b = yield* self.batch(bid);
      yield* checked("validate first send", () => {
        if (b.state !== "issuing" || b.attempted || !b.intent || !b.entry_key || !b.root || !outpoint(b.delegate_in) || b.fee_rate === null || b.recovery_paused)
          refuse("controller commitment was already attempted or is unavailable");
      });
      yield* self.guard(b);
      // This durable local flag precedes requesting even the one-use arm.
      b = yield* checked("persist attempt", () => self.db.patch(bid, { attempted: 1 }));
      const permission = yield* self.ports.registry.arm(b).pipe(Effect.matchCause({ onSuccess: value => ({ ok: true as const, value }), onFailure: () => ({ ok: false as const }) }));
      if (!permission.ok) {
        yield* self.uncertain(bid, "broadcast permission has no confirmed answer", "entry arm outcome uncertain");
        return yield* Effect.fail(new ControllerError({ code: "unavailable", message: "entry arm outcome uncertain; not sent" }));
      }
      const valid = yield* checked("validate exclusive arm", () => {
        const receipt = entryReceipt(permission.value, b, false, true);
        return receipt.found && "granted" in receipt && receipt.granted && receipt.acknowledged;
      }).pipe(Effect.matchCause({ onSuccess: value => value, onFailure: () => false }));
      const confirmed = valid && (yield* self.guard(b).pipe(Effect.matchCause({ onSuccess: () => true, onFailure: () => false })));
      if (!confirmed) {
        yield* self.uncertain(bid, "broadcast permission not exclusively confirmed", "entry arm outcome uncertain");
        return yield* Effect.fail(new ControllerError({ code: "refused", message: "broadcast permission unavailable or already consumed; not sent" }));
      }
      const response = yield* self.ports.broadcast(b.space, b.fee_rate!).pipe(Effect.matchCause({ onSuccess: value => ({ ok: true as const, value }), onFailure: () => ({ ok: false as const }) }));
      if (!response.ok) return yield* self.uncertain(bid, "no usable broadcast answer", "no answer");
      const answer = response.value;
      let txid: string | undefined;
      try {
        const value = strictJson(answer.body);
        if (answer.status >= 200 && answer.status < 300 && value && typeof value === "object" && !Array.isArray(value) &&
            hash((value as { txid?: unknown }).txid)) txid = (value as { txid: string }).txid;
      } catch { /* Every unusable answer is uncertain, including duplicate JSON keys. */ }
      if (!txid) return yield* self.uncertain(bid, `HTTP ${answer.status}: ${answer.body}`, "answer without usable txid");
      b = yield* checked("record broadcast", () => {
        const value = self.db.patch(bid, { state: "broadcast", txid: txid!, answer: bounded(answer.body) });
        appendIfAvailable(self.journal, value); return value;
      });
      const captured = yield* self.ports.capture(b);
      if (captured) b = yield* checked("record signed bytes", () => {
        if (captured.txid !== b.txid || !/^(?:[0-9a-f]{2})+$/.test(captured.raw) ||
            captured.ancestors.some(pair => pair.length !== 2 || !hash(pair[0]) || !/^(?:[0-9a-f]{2})+$/.test(pair[1])) ||
            new Set(captured.ancestors.map(pair => pair[0])).size !== captured.ancestors.length)
          refuse("captured controller transaction identity differs", "invalid");
        const value = self.db.patch(bid, { raw: captured.raw, ancestors: JSON.stringify(captured.ancestors) });
        appendIfAvailable(self.journal, value); return value;
      });
      return b;
    });
  }
}
