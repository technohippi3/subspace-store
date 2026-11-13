import { Effect } from "effect";
import { DurableStore } from "../../src/storage/store.ts";
import type { Config } from "../../src/application/store.ts";
import { decode, type Order } from "../../src/application/records.ts";
import type { Json } from "../../src/storage/codec.ts";
import { configuration } from "../../src/refunds/book.ts";

export function recovered(config: Config) {
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const storage=yield* DurableStore.open({ ...config, restore:false, requireRestore:true });
    const records=yield* storage.records();
    const state=decode(records,config.riskBudgetSats,configuration({ version:1,policy:config.refundPolicy,merchantDestinations:[...(config.merchantDestinations??[])] }));
    return { state, status:yield* storage.status(), records };
  })));
}
export function changeOrder(config: Config, id: string, update: Partial<Order>) {
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const storage=yield* DurableStore.open(config), row=yield* storage.get("sales_order",id);
    yield* storage.commit([{ kind:"sales_order",key:id,value:{ ...(row!.value as object),...update } as unknown as Json }]);
  })));
}
