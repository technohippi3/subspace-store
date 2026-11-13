import { Effect } from "effect";
import { checked, refuse } from "./errors.ts";
import type { ControllerEvent, ControllerJournal } from "./journal.ts";
import type { Result } from "./ports.ts";

interface Guard {
  version: 1; count: number; last_bid: string | null; paused_at: number | null; paused_bid: string | null;
}
const empty: Guard = { version: 1, count: 0, last_bid: null, paused_at: null, paused_bid: null };
const bid = (value: unknown): value is string => typeof value === "string" && /^b[1-9][0-9]*$/.test(value);
export function guardRecord(value: unknown): asserts value is ControllerEvent & Guard {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== "count,kind,last_bid,paused_at,paused_bid,seq,version") refuse("invalid rebuild guard history", "invalid");
  const v = value as Record<string, unknown>;
  if (v.kind !== "rebuild_guard" || v.version !== 1 || !Number.isSafeInteger(v.seq) || (v.seq as number) < 1 ||
      !Number.isSafeInteger(v.count) || (v.count as number) < 0) refuse("invalid rebuild guard history", "invalid");
  const valid = v.count === 0 ? v.last_bid === null && v.paused_at === null && v.paused_bid === null :
    (v.count as number) < 3 ? bid(v.last_bid) && v.paused_at === null && v.paused_bid === null :
      bid(v.last_bid) && v.paused_bid === v.last_bid && Number.isSafeInteger(v.paused_at) && (v.paused_at as number) >= 0;
  if (!valid) refuse("invalid rebuild guard history", "invalid");
}
/** The journal, rather than process-local counters, owns B5. */
export class RebuildPolicy {
  private readonly journal: ControllerJournal;
  private readonly height: () => Result<number>;
  constructor(journal: ControllerJournal, height: () => Result<number>) { this.journal = journal; this.height = height; }
  private rows(): (ControllerEvent & Guard)[] {
    return this.journal.entries().filter(event => event.kind === "rebuild_guard").map(event => { guardRecord(event); return event; });
  }
  private current(): Guard { return this.rows().at(-1) ?? empty; }
  private tip(): Result<number> {
    return this.height().pipe(Effect.flatMap(height => checked("validate rebuild height", () => {
      if (!Number.isSafeInteger(height) || height < 0) refuse("invalid controller block height", "invalid"); return height;
    })));
  }
  requireGate(): Result<void> {
    const self = this; return Effect.gen(function* () {
      const value = yield* checked("read rebuild policy", () => self.current());
      if (value.paused_at !== null && (yield* self.tip()) <= value.paused_at)
        return yield* checked("rebuild gate", () => refuse("three rebuilds in a row: paused until the next block"));
    });
  }
  note(bid: string): Result<void> {
    const self = this; return Effect.gen(function* () {
      const rows = yield* checked("read rebuild policy", () => self.rows());
      if (rows.some(row => row.last_bid === bid)) return;
      const value = rows.at(-1) ?? empty;
      const count = value.count + 1, paused = count >= 3 ? yield* self.tip() : null;
      yield* checked("acknowledge rebuild policy", () => self.journal.appendEvent("rebuild_guard", {
        version: 1, count, last_bid: bid, paused_at: paused, paused_bid: paused === null ? null : bid }));
    });
  }
  reset(): Result<void> {
    return checked("reset rebuild policy after fresh binding", () => {
      if (this.current().count) this.journal.appendEvent("rebuild_guard", { ...empty });
    });
  }
  paused(bid: string): boolean { return this.rows().some(row => row.paused_bid === bid); }
}
