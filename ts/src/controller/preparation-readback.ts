import { Effect } from "effect";
import { checked, refuse } from "./errors.ts";
import type { OrderBinding, Result } from "./ports.ts";
import type { PreparationPorts } from "./preparation-ports.ts";
import { commitFact, handleFact, pageFact, pipelineFact, type StagedHandle } from "./preparation-facts.ts";
import { hash, type Batch } from "./records.ts";

/** Complete, bounded public native readback. No head/root absence on transport failure. */
export class PreparationReadback {
  private readonly ports: PreparationPorts;
  constructor(ports: PreparationPorts) { this.ports = ports; }
  list(space: string, filter: "staged" | "committed"): Result<StagedHandle[]> {
    const self = this; return Effect.gen(function* () {
      const result: StagedHandle[] = [], seen = new Set<string>(); let total: number | undefined, pages = 1;
      for (let n = 1; n <= pages; n++) {
        const raw = yield* self.ports.native.page(space, n, filter), page = yield* checked("decode native preparation page", () => pageFact(raw, space, n, filter));
        yield* checked("validate stable native pages", () => {
          if (total !== undefined && (total !== page.total || pages !== Math.max(1, page.pages))) refuse("native staged pagination changed; reconciliation required");
          total = page.total; pages = Math.max(1, page.pages);
          for (const handle of page.handles) { if (seen.has(handle.name)) refuse("duplicate native staged label"); seen.add(handle.name); result.push(handle); }
        });
      }
      return result;
    });
  }
  staged(space: string): Result<StagedHandle[]> { return this.list(space, "staged"); }
  available(b: Batch, bindings: readonly OrderBinding[]): Result<void> {
    const self = this; return Effect.gen(function* () {
      for (const order of bindings) {
        const label = order.name.split("@")[0]!, raw = yield* self.ports.native.handle(b.space, label);
        if (raw === null) continue;
        yield* checked("confirm preexisting preparation member", () => {
          const value = handleFact(raw, b.space);
          if (value.name !== label || value.script_pubkey !== order.recipient_spk || value.commitment_root !== null)
            refuse("preexisting native member is committed or differs; reconciliation required", "restore_required");
        });
      }
    });
  }
  head(b: Batch): Result<void> {
    const self = this; return Effect.gen(function* () {
      const root = yield* self.ports.chainRoot(b.space), raw = yield* self.ports.native.pipeline(b.space);
      yield* checked("validate native preparation head", () => {
        if (root !== null && !hash(root) || root !== b.prior_root) refuse("chain prior root changed; preparation reconciliation required", "restore_required");
        const pipeline = pipelineFact(raw);
        if (pipeline.root !== root || pipeline.pending || root !== null && pipeline.txid === null)
          refuse("native commitment is ahead or ambiguous; preparation reconciliation required", "restore_required");
      });
    });
  }
  members(b: Batch, bindings: readonly OrderBinding[], root: string | null): Result<void> {
    const self = this; return Effect.gen(function* () {
      for (const order of bindings) {
        const label = order.name.split("@")[0]!, raw = yield* self.ports.native.handle(b.space, label);
        yield* checked("confirm exact preparation member", () => {
          const handle = handleFact(raw, b.space);
          if (handle.name !== label || handle.script_pubkey !== order.recipient_spk || handle.commitment_root !== root || handle.parked)
            refuse("native preparation member differs; reconciliation required", "restore_required");
        });
      }
    });
  }
  exact(b: Batch, bindings: readonly OrderBinding[]): Result<void> {
    const self = this; return Effect.gen(function* () {
      const staged = yield* self.staged(b.space), expected = new Map(bindings.map(o => [o.name.split("@")[0]!, o.recipient_spk]));
      yield* checked("confirm complete staged set", () => {
        const unparked = staged.filter(h => !h.parked);
        if (unparked.length !== expected.size || unparked.some(h => expected.get(h.name) !== h.script_pubkey))
          refuse("native staged set differs from frozen members");
      });
      yield* self.members(b, bindings, null);
    });
  }
  committed(b: Batch, bindings: readonly OrderBinding[], root: string): Result<void> {
    const self = this; return Effect.gen(function* () {
      yield* self.members(b, bindings, root);
      const staged = yield* self.staged(b.space), raw = yield* self.ports.native.pipeline(b.space);
      const committed = (yield* self.list(b.space, "committed")).filter(h => h.commitment_root === root);
      const pipeline = yield* checked("decode committed pipeline", () => pipelineFact(raw));
      yield* checked("confirm local commitment readback", () => {
        const expected = new Map(bindings.map(o => [o.name.split("@")[0]!, o.recipient_spk]));
        if (pipeline.root !== root || pipeline.txid !== null || !pipeline.pending || staged.some(h => expected.has(h.name)) ||
            committed.length !== expected.size || committed.some(h => h.parked || expected.get(h.name) !== h.script_pubkey))
          refuse("local commitment root or staged readback differs; reconciliation required", "restore_required");
      });
    });
  }
  response(raw: unknown, b: Batch): Result<string> { return checked("validate local commitment response", () => commitFact(raw, b)); }
}
