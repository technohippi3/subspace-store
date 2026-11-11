// Independent executable specification for the new pilot rules. Deliberately
// imports no production code. All time and chain evidence comes from callers.
export type State = "quoted" | "converted" | "issuing" | "cancelled" | "refund_due";
export interface Order {
  id: number; sequence: number; handle: string; quotedPrice: number; price: number; quotedAt: number;
  payFirst: boolean; state: State; seenHeight: number | null;
  acquiredHeight: number | null; everConverted: boolean; released: boolean;
}
export interface Payment { id: string; order: number; sats: number; confirmations: number }
interface Hold { order: number; at: number; converted: boolean }
export interface Snapshot {
  limit: number; now: number; tip: number; prices: Record<string, number>;
  orders: Order[]; payments: Payment[]; holds: Hold[]; conversions: number[];
  paused: boolean; nextId: number; refunded: Record<string, number>;
}
function whole(n: number, minimum = 0): void {
  if (!Number.isSafeInteger(n) || n < minimum) throw Error("invalid whole amount or time");
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export class Pilot {
  private data: Snapshot;
  constructor(limit: number) {
    whole(limit, 1);
    this.data = { limit, now: 0, tip: 0, prices: {}, orders: [], payments: [],
      holds: [], conversions: [], paused: false, nextId: 1, refunded: {} };
  }
  static restore(snapshot: Snapshot): Pilot {
    const result = new Pilot(snapshot.limit);
    result.data = copy(snapshot);
    result.data.paused = true;
    return result;
  }
  snapshot(): Snapshot { return copy(this.data); }
  order(id: number): Order {
    const result = this.data.orders.find(o => o.id === id);
    if (!result) throw Error("unknown order");
    return copy(result);
  }
  private mutable(id: number): Order {
    const result = this.data.orders.find(o => o.id === id);
    if (!result) throw Error("unknown order");
    return result;
  }
  price(handle: string, sats: number): void {
    whole(sats, 1);
    this.data.prices[handle] = sats;
  }
  pause(paused: boolean): void { this.data.paused = paused; }
  convertedCount(): number { return this.data.conversions.length; }
  private sum(order: Order, depth: number): number {
    return this.data.payments.filter(p => p.order === order.id && p.confirmations >= depth)
      .reduce((sum, p) => sum + p.sats, 0);
  }
  private active(order: Order): boolean {
    if (order.state !== "quoted" || order.released) return false;
    if (order.acquiredHeight !== null)
      return this.data.tip <= order.acquiredHeight + 6 || this.sum(order, 1) >= order.price;
    if (order.payFirst) return false;
    return this.data.now < order.quotedAt + 900 || (order.seenHeight !== null &&
      (this.data.tip <= order.seenHeight + 6 || this.sum(order, 1) >= order.price));
  }
  private owner(handle: string): Order | undefined {
    return this.data.orders.find(o => o.handle === handle &&
      (o.state === "converted" || o.state === "issuing" || this.active(o)));
  }
  exposure(): number {
    const confirmed = this.data.payments.filter(p => p.confirmations >= 1)
      .reduce((sum, p) => sum + p.sats, 0) - Object.values(this.data.refunded).reduce((sum, value) => sum + value, 0);
    return confirmed + this.data.orders.filter(o => this.active(o))
      .reduce((sum, o) => sum + Math.max(0, o.price - this.sum(o, 1)), 0);
  }
  quote(handle: string, creationSequence = this.data.nextId): Order {
    whole(creationSequence, 1);
    if (this.data.orders.some(o => o.sequence === creationSequence)) throw Error("duplicate creation sequence");
    const price = this.data.prices[handle];
    if (price === undefined) throw Error("not listed");
    if (this.data.paused) throw Error("sales paused");
    if (this.owner(handle)) throw Error("name taken");
    const confirmed = this.data.payments.filter(p => p.confirmations >= 1)
      .reduce((sum, p) => sum + p.sats, 0) - Object.values(this.data.refunded).reduce((sum, value) => sum + value, 0);
    if (confirmed + price > this.data.limit) throw Error("exposure limit");
    const ration = this.data.holds.filter(h => h.at > this.data.now - 86400 &&
      this.mutable(h.order).handle === handle && !h.converted).length;
    const open = this.data.orders.filter(o => this.active(o)).length;
    const payFirst = ration >= 2 || open >= 10 || this.exposure() + price > this.data.limit;
    const order: Order = { id: this.data.nextId++, sequence: creationSequence, handle, quotedPrice: price, price,
      quotedAt: this.data.now, payFirst, state: "quoted", seenHeight: null,
      acquiredHeight: null, everConverted: false, released: payFirst };
    this.data.orders.push(order);
    if (!payFirst) this.data.holds.push({ order: order.id, at: this.data.now, converted: false });
    return copy(order);
  }
  private convert(order: Order): void {
    if (this.active(order) && this.sum(order, 3) >= order.price) {
      order.state = "converted";
      order.everConverted = true;
      const hold = this.data.holds.findLast(h => h.order === order.id);
      if (hold) hold.converted = true;
      if (!this.data.conversions.includes(order.id)) this.data.conversions.push(order.id);
      if (this.data.conversions.length === 10) this.data.paused = true;
    }
  }
  observe(now: number, tip: number, payments: Payment[]): void {
    whole(now); whole(tip);
    if (now < this.data.now) throw Error("clock moved backwards");
    const ids = new Set<string>();
    for (const payment of payments) {
      whole(payment.sats, 1); whole(payment.confirmations);
      this.mutable(payment.order);
      if (ids.has(payment.id)) throw Error("duplicate outpoint");
      ids.add(payment.id);
    }
    this.data.now = now;
    this.data.tip = tip;
    this.data.payments = copy(payments);
    for (const order of this.data.orders) {
      if (!order.payFirst && order.state === "quoted" && order.seenHeight === null &&
          now < order.quotedAt + 900 && this.sum(order, 0) > 0) order.seenHeight = tip;
      if (order.state === "quoted" && !this.active(order)) order.released = true;
      this.convert(order);
    }
    // Reconstruct the block in which the full amount qualified, so reading
    // several blocks after downtime does not turn all payments into a tie.
    const qualifiedAt = (order: Order, price: number): number => {
      const outputs = this.data.payments.filter(p => p.order === order.id && p.confirmations >= 1)
        .sort((a, b) => b.confirmations - a.confirmations);
      let sum = 0;
      for (const output of outputs) {
        sum += output.sats;
        if (sum >= price) return tip - output.confirmations + 1;
      }
      return Infinity;
    };
    const candidates = this.data.orders.filter(o => o.state === "quoted" && !this.active(o));
    const needed = (o: Order): number => now < o.quotedAt + 900 ? o.quotedPrice :
      (this.data.prices[o.handle] ?? Infinity);
    candidates.sort((a, b) => qualifiedAt(a, Math.min(needed(a), a.quotedPrice)) -
      qualifiedAt(b, Math.min(needed(b), b.quotedPrice)) ||
      a.quotedAt - b.quotedAt || a.sequence - b.sequence);
    for (const order of candidates) {
      const price = needed(order);
      if (this.sum(order, 1) < Math.min(price, order.quotedPrice)) {
        // An ordinary hold ending short follows P5. Pay-first has no hold
        // to expire and may accumulate the full amount without reserving.
        if (!order.payFirst && this.sum(order, 1) > 0) order.state = "refund_due";
        continue;
      }
      if (price > order.quotedPrice || this.owner(order.handle)) {
        order.state = "refund_due";
        continue;
      }
      order.price = price;
      order.released = false;
      order.acquiredHeight = tip;
      this.data.holds.push({ order: order.id, at: now, converted: false });
      this.convert(order);
    }
  }
  recordRefund(id: number, charged: number): void {
    whole(charged, 1);
    const order = this.mutable(id);
    const previous = this.data.refunded[id] ?? 0;
    const reserve = order.state === "cancelled" || order.state === "refund_due" ? 0 : order.price;
    if (charged + previous > this.sum(order, 6) - reserve) throw Error("refund not authorized");
    this.data.refunded[id] = previous + charged;
  }
  cancel(id: number): void {
    const order = this.mutable(id);
    if (order.state === "issuing") throw Error("already issuing");
    order.state = "cancelled";
  }
  beginIssuance(id: number): void {
    const order = this.mutable(id);
    if (order.state !== "converted" || this.sum(order, 3) < order.price) throw Error("not batchable");
    order.state = "issuing";
  }
}
