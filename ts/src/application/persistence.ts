import { Effect } from "effect";
import type { DurableStore } from "../storage/store.ts";
import { decode, encode, verified, type Record, type RefundSettings, type State } from "./records.ts";

/** Shared validation and changed-record persistence, never model logic. */
export function persist(storage: DurableStore, before: readonly Record[], state: State, riskBudget: number, refunds: RefundSettings) {
  return Effect.gen(function* () {
    const after = yield* verified(() => { const records = encode(state); decode(records, riskBudget, refunds); return records; });
    const previous = new Map(before.map(r => [JSON.stringify([r.kind, r.key]), JSON.stringify(r.value)]));
    const changed = after.filter(r => previous.get(JSON.stringify([r.kind, r.key])) !== JSON.stringify(r.value));
    if (changed.length) yield* storage.commit(changed);
  });
}
