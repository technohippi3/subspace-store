import { createHash, randomBytes } from "node:crypto";
import { Effect, Semaphore } from "effect";
import { canonicalHandle } from "../recipient.ts";
import { DurableStore, type StorageConfig } from "../storage/store.ts";
import { ApplicationError, checked, claims, decode, destination, encode, fail, request, sats, verified,
  type Destination, type Order, type Record, type Snapshot, type State } from "./records.ts";
import { active, admission, grant, refresh, release, total } from "./sales.ts";

export interface Adapters {
  readonly clock: () => number;
  readonly snapshot: (destinations: readonly Destination[]) => Effect.Effect<Snapshot, ApplicationError>;
  readonly newDestination: Effect.Effect<Destination, ApplicationError>;
}
export interface Config extends StorageConfig { readonly riskBudgetSats: number }
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
/** One serialized application queue, including asynchronous wallet/chain work.
 * SQLite transactions cover only local writes; no RPC runs inside one. */
export class SalesStore {
  private readonly queue = Semaphore.makeUnsafe(1);
  private readonly storage: DurableStore;
  private readonly adapters: Adapters;
  private readonly budget: number;
  private constructor(storage: DurableStore, adapters: Adapters, budget: number) {
    this.storage = storage; this.adapters = adapters; this.budget = budget;
  }
  static open(config: Config, adapters: Adapters) {
    return Effect.gen(function* () {
      yield* checked(() => sats(config.riskBudgetSats));
      const storage = yield* DurableStore.open(config);
      const result = new SalesStore(storage, adapters, config.riskBudgetSats);
      if ((yield* storage.status()).restoreRequired)
        return yield* checked(() => fail("restored application requires controller and chain reconciliation", "unavailable"));
      const { records, state } = yield* result.load();
      yield* result.save(records, state);
      return result;
    });
  }
  private load() {
    const self = this;
    return Effect.gen(function* () {
      const records = yield* self.storage.records();
      const state = yield* verified(() => decode(records, self.budget));
      return { records, state };
    });
  }
  private save(before: readonly Record[], state: State) {
    const self = this;
    return Effect.gen(function* () {
      const after = yield* verified(() => { const records = encode(state); decode(records, self.budget); return records; });
      const previous = new Map(before.map(r => [JSON.stringify([r.kind, r.key]), JSON.stringify(r.value)]));
      const changed = after.filter(r => previous.get(JSON.stringify([r.kind, r.key])) !== JSON.stringify(r.value));
      if (changed.length) yield* self.storage.commit(changed);
    });
  }
  private refresh() {
    const self = this;
    return Effect.gen(function* () {
      const current = yield* self.load();
      const destinations = current.state.orders.flatMap(o => o.destination ? [{ ...o.destination }] : []);
      const snapshot = yield* self.adapters.snapshot(destinations);
      yield* verified(() => refresh(current.state, self.adapters.clock(), snapshot));
      yield* self.save(current.records, current.state);
      return yield* self.load();
    });
  }
  private find(state: State, token: string): Order {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token)) fail("no such order", "not_found");
    const order = state.orders.find(o => o.tokenHash === hash(token));
    return order ?? fail("no such order", "not_found");
  }
  private recipient(state: State, order: Order): void {
    if (state.orders.some(o => o.destination?.script === order.recipient ||
        (o.handle !== order.handle && o.recipient === order.recipient && claims(o)))) fail("script already used");
  }
  private view(state: State, order: Order) {
    const self = this;
    return Effect.gen(function* () {
      const saved = yield* self.storage.acknowledged("sales_order", order.id);
      const acknowledged = saved?.value as unknown as Order | null | undefined;
      const cancelled = order.status === "cancelled";
      const final = cancelled && acknowledged?.status === "cancelled";
      const hold = active(state, order) ? order.grants.at(-1)! : null;
      const rejected = state.orders.some(o => o.destination?.script === order.recipient ||
        (o.handle !== order.handle && claims(o) && o.recipient === order.recipient));
      return { handle: order.handle, recipient_script_pubkey: order.recipient,
        status: cancelled && !final ? (acknowledged?.status ?? "requested") : order.status,
        cancellation: cancelled ? (final ? "final" : "unconfirmed") : null,
        price_sats: order.price,
        address: rejected ? null : acknowledged?.destination?.address ?? null,
        address_pending: !rejected && !!order.destination && !acknowledged?.destination,
        recipient_rejected: rejected,
        acknowledged: !!acknowledged?.destination,
        pay_first: order.payFirst,
        payment_warning: order.payFirst ? "This invoice does not reserve the name. Another buyer may pay first; if that happens, your payment is refunded less the refund fee." : null,
        quote_expires_at: order.quotedAt === null ? null : order.quotedAt + 900,
        hold_expires_at: hold?.until ?? null,
        detected_sats: total(state, order, 0), confirmed_sats: total(state, order, 1),
        batchable_sats: total(state, order, 3), settled_sats: total(state, order, 6),
        payment_history: order.paymentHistory,
        reconciling: claims(order) && total(state, order, 3) < order.price! ? ["issuance"] : [] };
    });
  }
  request(body: unknown) {
    const self = this;
    return Effect.gen(function* () {
      // Malformed bodies are rejected before entering the queue or reading state.
      const input = yield* checked(() => request(body));
      return yield* self.queue.withPermit(Effect.gen(function* () {
        const { records, state } = yield* self.load();
        yield* checked(() => {
          if (!state.listings.some(n => n.handle === input.handle)) fail("not for sale");
          if (state.orders.some(o => o.destination?.script === input.script ||
              (o.handle !== input.handle && claims(o) && o.recipient === input.script))) fail("script already used");
        });
        const token = randomBytes(24).toString("base64url"), sequence = state.settings.nextOrder++;
        state.orders.push({ id: `o${sequence}`, sequence, handle: input.handle, space: input.handle.split("@")[1]!,
          recipient: input.script, tokenHash: hash(token), status: "requested", quotedAt: null,
          quotedPrice: null, price: null, destination: null, payFirst: false, grants: [],
          everConverted: false, paymentHistory: "none", lateEvaluated: false });
        yield* self.save(records, state);
        return { order_link: `/orders/${token}`, token };
      }));
    });
  }
  quote(token: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      // Authenticate before touching the chain or wallet.
      const initial = yield* self.load();
      yield* checked(() => self.find(initial.state, token));
      const { records, state } = yield* self.refresh();
      const order = yield* checked(() => self.find(state, token));
      yield* checked(() => self.recipient(state, order));
      if (order.status === "quoted" && order.destination) {
        yield* self.storage.flush();
        return yield* self.view(state, order);
      }
      yield* checked(() => {
        if (order.status !== "requested") fail("already quoted");
        return admission(state, order);
      });
      const flushed = yield* self.storage.flush();
      const position = yield* self.storage.status();
      if (!flushed || !(yield* self.storage.confirm(position.seq)))
        return yield* checked(() => fail("the off-host journal is unavailable; no quote was made", "unavailable"));
      const held = new Set(state.orders.flatMap(o => o.destination ? [o.destination.script] : []));
      let chosen: Destination | undefined;
      for (let draw = 0; draw <= held.size; draw++) {
        const candidate = yield* self.adapters.newDestination;
        yield* verified(() => destination(candidate));
        if (!held.has(candidate.script)) { chosen = { ...candidate }; break; }
      }
      yield* checked(() => {
        if (!chosen) fail("the payment wallet gave out only addresses that orders hold; no quote was made");
        if (chosen.script === order.recipient) fail("recipient is a store destination script");
        // Wallet work can take time. Re-evaluate timers before granting the
        // invoice, while retaining the queue and the last real chain evidence.
        refresh(state, self.adapters.clock(), { tip: state.settings.tip,
          outputs: state.payments.filter(p => p.active) });
        const payFirst = admission(state, order);
        order.destination = chosen; order.payFirst = payFirst; order.status = "quoted";
        order.quotedAt = state.settings.lastTime;
        order.price = order.quotedPrice = state.listings.find(n => n.handle === order.handle)!.price;
        if (!payFirst) grant(state, order);
      });
      yield* self.save(records, state);
      return yield* self.view(state, order);
    }));
  }
  order(token: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const initial = yield* self.load();
      yield* checked(() => self.find(initial.state, token));
      const { state } = yield* self.refresh();
      yield* self.storage.flush();
      const order = yield* checked(() => self.find(state, token));
      return yield* self.view(state, order);
    }));
  }
  cancel(token: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const initial = yield* self.load();
      yield* checked(() => self.find(initial.state, token));
      const { records, state } = yield* self.refresh();
      const order = yield* checked(() => self.find(state, token));
      yield* checked(() => {
        if (order.status === "issuing") fail("not cancellable once issuing");
        order.status = "cancelled"; release(order);
      });
      yield* self.save(records, state);
      yield* self.storage.flush();
      return yield* self.view(state, order);
    }));
  }
  observe() { return this.queue.withPermit(this.refresh().pipe(Effect.asVoid)); }
  /** Freezes an order only; this does not sign, broadcast or serve a batch. */
  beginIssuance(id: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { records, state } = yield* self.refresh();
      yield* checked(() => {
        const order = state.orders.find(o => o.id === id) ?? fail("no such order", "not_found");
        if (order.status !== "converted" || total(state, order, 3) < order.price!) fail("not batchable");
        self.recipient(state, order);
        order.status = "issuing";
      });
      yield* self.save(records, state);
    }));
  }
  listName(handle: string, price: number) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      yield* checked(() => { if (!canonicalHandle(handle)) fail("invalid handle", "invalid"); sats(price); });
      const { records, state } = yield* self.load();
      const listing = state.listings.find(n => n.handle === handle);
      if (listing) listing.price = price;
      else state.listings.push({ handle, space: handle.split("@")[1]!, price });
      yield* self.save(records, state);
    }));
  }
  pause(paused: boolean) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { records, state } = yield* self.load();
      state.settings.paused = paused;
      yield* self.save(records, state);
      yield* self.storage.flush();
      const saved = yield* self.storage.acknowledged("sales_settings", "global");
      return { paused, acknowledged: !!saved && (saved.value as { paused: boolean }).paused === paused };
    }));
  }
}
