// Independent deterministic executable specification. No production imports,
// wall clock, network, database, wallet implementation or unseeded randomness.
export type OrderState = "requested" | "quoted" | "unpaid" | "converted" | "issuing" | "ready" | "fulfilled" | "cancelled" | "refund_due";
export interface Limits { riskBudget: number; requestWindowSeconds: number; requestsPerWindow: number; maximumOrders: number }
export interface Space { space: string; paused: boolean; catalog: "listed" }
export interface Name { handle: string; space: string; price: number; reserved: boolean; withdrawn: boolean }
export interface Hold { at: number; until: number; seenHeight: number | null; acquiredHeight: number | null; released: boolean; converted: boolean }
export interface Order {
  id: number; sequence: number; handle: string; recipient: string; token: string;
  state: OrderState; quotedAt: number | null; quotedPrice: number | null; price: number | null;
  destination: string | null; payFirst: boolean; holds: Hold[]; withdrawalAt: number | null;
  lateEvaluated: boolean; everConverted: boolean; certificate: string | null;
}
export interface Payment { outpoint: string; order: number; sats: number; confirmations: number }
export type Seen = "absent" | "mempool" | "mined" | "unknown";
export interface Refund {
  group: string; order: number; txid: string; bytes: string; principal: number;
  attempted: boolean; seen: Seen; confirmations: number; reserved: number; refunded: number; sendCalls: number;
}
export interface RefundFact { group: string; txid: string; seen: Seen; confirmations: number }
export interface OwnerIntent { operation: string; handle: string; recipient: string; confirm: string; expectedSequence: number }
export interface OwnerAuthorization extends OwnerIntent { order: number; price: number; authorizedAt: number }
export interface OwnerContext { authenticated: boolean; journalAcknowledged: boolean; recoveryReady: boolean; issuanceReady: boolean }
export type OwnerReceipt = { created: true; order: number; status: OrderState; invoice: Order } |
  { created: false; order: number; status: OrderState };
export interface Snapshot {
  limits: Limits; now: number; tip: number; nextOrder: number; nextDestination: number;
  spaces: Space[]; names: Name[]; orders: Order[]; payments: Payment[]; refunds: Refund[];
  paused: boolean; conversions: number[]; requestWindow: { startedAt: number; created: number };
  startupObserved: boolean; revision: number; ownerAuthorizations: OwnerAuthorization[];
}
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function whole(n: number, minimum = 0): void { if (!Number.isSafeInteger(n) || n < minimum) throw Error("invalid integer"); }
function copy<T>(v: T): T { return structuredClone(v); }
function spaceOf(handle: string): string {
  const parts = handle.split("@");
  if (parts.length !== 2 || !label.test(parts[0]!) || !label.test(parts[1]!)) throw Error("invalid handle");
  return parts[1]!;
}
const claimed = (o: Order): boolean => ["converted", "issuing", "ready", "fulfilled"].includes(o.state);

export class Seller {
  private data: Snapshot;
  constructor(limits: Limits) {
    if (Object.keys(limits).sort().join() !== "maximumOrders,requestWindowSeconds,requestsPerWindow,riskBudget") throw Error("explicit limits required");
    for (const value of Object.values(limits)) whole(value, 1);
    this.data = { limits: copy(limits), now: 0, tip: 0, nextOrder: 1, nextDestination: 1,
      spaces: [], names: [], orders: [], payments: [], refunds: [], paused: true,
      conversions: [], requestWindow: { startedAt: 0, created: 0 }, startupObserved: false,
      revision: 0, ownerAuthorizations: [] };
  }
  static restore(snapshot: Snapshot): Seller {
    const result = new Seller(snapshot.limits);
    result.data = copy(snapshot); result.data.paused = true; result.data.startupObserved = false;
    // Missing current node facts cannot establish an absent refund.
    for (const refund of result.data.refunds) { refund.seen = "unknown"; refund.confirmations = 0; }
    return result;
  }
  snapshot(): Snapshot { return copy(this.data); }
  order(id: number): Order { return copy(this.mutable(id)); }
  private mutable(id: number): Order { return this.data.orders.find(o => o.id === id) ?? this.refuse("unknown order"); }
  private name(handle: string): Name { return this.data.names.find(n => n.handle === handle) ?? this.refuse("not listed"); }
  private space(space: string): Space { return this.data.spaces.find(s => s.space === space) ?? this.refuse("unknown space"); }
  private refuse(message: string): never { throw Error(message); }
  setup(space: string): void {
    if (!label.test(space)) throw Error("invalid space");
    if (!this.data.spaces.some(s => s.space === space)) {
      this.data.spaces.push({ space, paused: false, catalog: "listed" }); this.data.revision++;
    }
  }
  list(handle: string, price: number): void {
    const space = spaceOf(handle); whole(price, 1); this.space(space);
    const found = this.data.names.find(n => n.handle === handle);
    if (found) { if (found.price !== price) this.data.revision++; found.price = price; }
    else { this.data.names.push({ handle, space, price, reserved: false, withdrawn: false }); this.data.revision++; }
  }
  pause(paused: boolean, space?: string): void {
    if (typeof paused !== "boolean") throw Error("invalid pause");
    if (space === undefined) { if (this.data.paused !== paused) this.data.revision++; this.data.paused = paused; }
    else { const target = this.space(space); if (target.paused !== paused) this.data.revision++; target.paused = paused; }
  }
  reserve(handle: string, reserved: boolean): void {
    if (typeof reserved !== "boolean") throw Error("invalid reservation");
    const name = this.name(handle); if (name.reserved !== reserved) this.data.revision++; name.reserved = reserved;
  }
  withdraw(handle: string, withdrawn: boolean): void {
    if (typeof withdrawn !== "boolean") throw Error("invalid withdrawal");
    const name = this.name(handle); let changed = name.withdrawn !== withdrawn; name.withdrawn = withdrawn;
    if (withdrawn) for (const order of this.data.orders) {
      if (order.handle === handle && order.destination !== null && !claimed(order) &&
          !["cancelled", "refund_due"].includes(order.state) && order.withdrawalAt === null) {
        order.withdrawalAt = this.data.now; changed = true;
      }
    }
    if (changed) this.data.revision++;
  }
  request(handle: string, recipient: string): Order {
    spaceOf(handle); this.name(handle);
    if (typeof recipient !== "string" || recipient.length === 0) throw Error("invalid recipient");
    if (this.data.orders.some(o => o.destination === recipient || (o.handle !== handle && o.recipient === recipient && claimed(o))))
      throw Error("script already used");
    const limits = this.data.limits, window = this.data.requestWindow;
    if (this.data.orders.length >= limits.maximumOrders) throw Error("request capacity reached");
    // Capacity checking precedes window mutation. A refused request changes no
    // counter, order sequence, destination or script claim.
    const elapsed = this.data.now - window.startedAt >= limits.requestWindowSeconds;
    if (!elapsed && window.created >= limits.requestsPerWindow) throw Error("request rate exceeded");
    if (elapsed) { window.startedAt = this.data.now; window.created = 0; }
    const id = this.data.nextOrder++;
    const order: Order = { id, sequence: id, handle, recipient, token: `opaque-link-${id}`,
      state: "requested", quotedAt: null, quotedPrice: null, price: null, destination: null,
      payFirst: false, holds: [], withdrawalAt: null, lateEvaluated: false, everConverted: false, certificate: null };
    this.data.orders.push(order); window.created++; this.data.revision++;
    return copy(order);
  }
  ownerInvoice(intent: OwnerIntent, context: OwnerContext): OwnerReceipt {
    if (!context.authenticated) throw Error("operator authentication required");
    if (Object.keys(intent).sort().join() !== "confirm,expectedSequence,handle,operation,recipient" ||
        !/^[A-Za-z0-9_-]{32}$/.test(intent.operation) || intent.confirm !== intent.handle) throw Error("exact owner nomination required");
    spaceOf(intent.handle); whole(intent.expectedSequence);
    const previous = this.data.ownerAuthorizations.find(a => a.operation === intent.operation);
    if (previous) {
      if (previous.handle !== intent.handle || previous.recipient !== intent.recipient || previous.confirm !== intent.confirm || previous.expectedSequence !== intent.expectedSequence)
        throw Error("owner operation binding differs");
      // Operator authentication does not authorize redisclosure of a buyer
      // bearer link. A lost fresh reply is inspected by order ID instead.
      return { created: false, order: previous.order, status: this.mutable(previous.order).state };
    }
    if (!context.journalAcknowledged || !context.recoveryReady || !context.issuanceReady) throw Error("owner operation readiness required");
    if (intent.expectedSequence !== this.data.revision) throw Error("stale owner preview");
    const before = copy(this.data);
    try {
      const order = this.request(intent.handle, intent.recipient), price = this.name(intent.handle).price;
      this.data.ownerAuthorizations.push({ ...copy(intent), order: order.id, price, authorizedAt: this.data.now });
      const quoted = this.quote(order.id);
      return { created: true, order: order.id, status: quoted.state, invoice: quoted };
    } catch (error) { this.data = before; throw error; }
  }
  private authorizedOwner(o: Order): boolean {
    return this.data.ownerAuthorizations.some(a => a.order === o.id && a.handle === o.handle && a.recipient === o.recipient &&
      a.price === (o.quotedPrice ?? this.name(o.handle).price));
  }
  private sum(order: Order, depth: number): number {
    return this.data.payments.filter(p => p.order === order.id && p.confirmations >= depth).reduce((s, p) => s + p.sats, 0);
  }
  active(id: number): boolean {
    const o = this.mutable(id), h = o.holds.at(-1);
    if (o.state !== "quoted" || !h || h.released) return false;
    if (h.acquiredHeight !== null) return this.data.tip <= h.acquiredHeight + 6 || this.sum(o, 1) >= o.price!;
    return this.data.now < h.until || (h.seenHeight !== null &&
      (this.data.tip <= h.seenHeight + 6 || this.sum(o, 1) >= o.price!));
  }
  refundOnly(id: number): boolean {
    const o = this.mutable(id);
    return ["cancelled", "refund_due"].includes(o.state) || (o.withdrawalAt !== null && !claimed(o) && !this.active(id) &&
      (!o.payFirst || this.data.now >= o.quotedAt! + 900));
  }
  private owner(handle: string): Order | undefined {
    return this.data.orders.find(o => o.handle === handle && (claimed(o) || this.active(o.id)));
  }
  private grant(o: Order, acquired = false): void {
    o.holds.push({ at: this.data.now, until: this.data.now + 900, seenHeight: null,
      acquiredHeight: acquired ? this.data.tip : null, released: false, converted: false });
  }
  exposureLimit(): number { return Math.min(this.data.limits.riskBudget, 10 * Math.max(0, ...this.data.names.map(n => n.price))); }
  private confirmed(): number {
    return this.data.payments.filter(p => p.confirmations >= 1).reduce((s, p) => s + p.sats, 0) -
      this.data.refunds.reduce((s, r) => s + r.refunded, 0);
  }
  exposure(): number {
    return this.confirmed() + this.data.orders.filter(o => this.active(o.id)).reduce((s, o) => s + Math.max(0, o.price! - this.sum(o, 1)), 0);
  }
  quote(id: number): Order {
    const o = this.mutable(id), name = this.name(o.handle);
    if (o.state === "quoted" && o.destination) return copy(o);
    if (o.state !== "requested") throw Error("already quoted");
    if (this.data.paused || this.space(name.space).paused) throw Error("sales paused");
    if ((name.reserved && !this.authorizedOwner(o)) || name.withdrawn) throw Error("name unavailable");
    if (this.owner(o.handle)) throw Error("name taken");
    if (this.confirmed() + name.price > this.exposureLimit()) throw Error("exposure limit");
    if (this.data.orders.some(x => x.destination === o.recipient || (x.handle !== o.handle && x.recipient === o.recipient && claimed(x))))
      throw Error("script already used");
    const counted = this.data.orders.filter(x => x.handle === o.handle).flatMap(x => x.holds)
      .filter(h => h.at > this.data.now - 86_400 && !h.converted).length;
    o.payFirst = counted >= 2 || this.data.orders.filter(x => this.active(x.id)).length >= 10 || this.exposure() + name.price > this.exposureLimit();
    o.destination = `invoice-destination-${this.data.nextDestination++}`;
    o.state = "quoted"; o.quotedAt = this.data.now; o.price = o.quotedPrice = name.price;
    if (!o.payFirst) this.grant(o);
    this.data.revision++;
    return copy(o);
  }
  private convert(o: Order): void {
    if (!this.active(o.id) || this.sum(o, 3) < o.price!) return;
    o.state = "converted"; o.everConverted = true; o.holds.at(-1)!.converted = true;
    if (!this.data.conversions.includes(o.id)) {
      this.data.conversions.push(o.id);
      if (this.data.conversions.length === 10) this.data.paused = true;
    }
  }
  observe(now: number, tip: number, payments: Payment[]): void {
    whole(now); whole(tip);
    if (now < this.data.now) throw Error("clock moved backwards");
    const seen = new Set<string>();
    for (const p of payments) {
      this.mutable(p.order); whole(p.sats, 1); whole(p.confirmations);
      if (!p.outpoint || seen.has(p.outpoint) || p.confirmations > tip + 1) throw Error("invalid payment facts");
      const old = this.data.payments.find(v => v.outpoint === p.outpoint);
      if (old && (old.order !== p.order || old.sats !== p.sats)) throw Error("payment binding changed");
      seen.add(p.outpoint);
    }
    const material = (): string => JSON.stringify({ orders: this.data.orders.map(o => ({...o,
      active: this.active(o.id), refundOnly: this.refundOnly(o.id)})), payments: this.data.payments });
    const before = material();
    this.data.now = now; this.data.tip = tip; this.data.payments = copy(payments);
    for (const o of this.data.orders.filter(o => o.state === "quoted")) {
      const h = o.holds.at(-1);
      if (h && !h.released && h.seenHeight === null && now < h.until && this.sum(o, 0) > 0) h.seenHeight = tip;
      if (h && !this.active(o.id)) h.released = true;
      this.convert(o);
      if (o.state === "quoted" && !o.payFirst && !this.active(o.id)) o.state = "unpaid";
    }
    const needed = (o: Order): number => now < o.quotedAt! + 900 ? o.quotedPrice! : this.name(o.handle).price;
    const qualifyingBlock = (o: Order): number => {
      let sum = 0;
      for (const p of this.data.payments.filter(p => p.order === o.id && p.confirmations > 0).sort((a, b) => b.confirmations - a.confirmations)) {
        sum += p.sats;
        if (sum >= Math.min(needed(o), o.quotedPrice!)) return tip - p.confirmations + 1;
      }
      return Infinity;
    };
    const candidates = this.data.orders.filter(o => (o.state === "quoted" && o.payFirst && !this.active(o.id)) || (o.state === "unpaid" && !o.lateEvaluated));
    candidates.sort((a, b) => qualifyingBlock(a) - qualifyingBlock(b) || a.quotedAt! - b.quotedAt! || a.sequence - b.sequence);
    for (const o of candidates) {
      const name = this.name(o.handle), confirmed = this.sum(o, 1);
      const withdrawalGrace = o.payFirst && o.withdrawalAt !== null && now < o.quotedAt! + 900;
      if (this.refundOnly(o.id) || (name.reserved && !this.authorizedOwner(o)) || (name.withdrawn && !withdrawalGrace)) {
        if (confirmed > 0) { o.state = "refund_due"; o.lateEvaluated = true; }
        continue;
      }
      const required = needed(o);
      if (confirmed < Math.min(required, o.quotedPrice!)) {
        if (!o.payFirst && confirmed > 0) { o.state = "refund_due"; o.lateEvaluated = true; }
        continue;
      }
      o.lateEvaluated = true;
      if (required > o.quotedPrice! || this.owner(o.handle)) { o.state = "refund_due"; continue; }
      o.price = required; o.state = "quoted"; this.grant(o, true); this.convert(o);
    }
    if (before !== material()) this.data.revision++;
  }
  cancel(id: number): void {
    const o = this.mutable(id);
    if (["issuing", "ready", "fulfilled"].includes(o.state)) throw Error("already issuing");
    o.state = "cancelled"; const hold = o.holds.at(-1); if (hold) hold.released = true;
    this.data.revision++;
  }
  beginIssuance(id: number): void {
    const o = this.mutable(id);
    if (o.state !== "converted" || this.sum(o, 3) < o.price!) throw Error("not batchable");
    if (this.data.orders.some(other => other.handle !== o.handle && other.recipient === o.recipient && claimed(other))) throw Error("script conflict");
    o.state = "issuing"; this.data.revision++;
  }
  deliver(id: number, certificate: string): void {
    const o = this.mutable(id);
    if (o.state !== "issuing" || !certificate) throw Error("not issuing");
    o.certificate = certificate; o.state = "fulfilled"; this.data.revision++;
  }
  // Fixtures supply an already acknowledged exact signed historical attempt;
  // this is state installation, not a transaction builder or wallet action.
  recordRefund(refund: Refund): void {
    const o = this.mutable(refund.order); whole(refund.principal, 1); whole(refund.reserved); whole(refund.refunded); whole(refund.sendCalls); whole(refund.confirmations);
    const historicalPrincipal = this.data.refunds.filter(r => r.order === o.id).reduce((sum, r) => sum + r.principal, 0);
    if (!this.refundOnly(o.id) || this.sum(o, 6) < historicalPrincipal + refund.principal || this.data.refunds.some(r => r.group === refund.group || r.txid === refund.txid) ||
        !refund.bytes || !refund.txid || refund.reserved + refund.refunded !== refund.principal) throw Error("invalid refund history");
    this.data.refunds.push(copy(refund)); this.data.startupObserved = false; this.data.revision++;
  }
  startup(facts: RefundFact[]): { ready: boolean; pending: string[] } {
    if (facts.length !== this.data.refunds.length || new Set(facts.map(f => f.group)).size !== facts.length) throw Error("incomplete refund observation");
    for (const r of this.data.refunds) {
      const fact = facts.find(f => f.group === r.group);
      if (!fact || fact.txid !== r.txid || !["absent", "mempool", "mined", "unknown"].includes(fact.seen)) throw Error("refund observation differs");
      whole(fact.confirmations);
      if ((fact.seen === "mined") !== (fact.confirmations > 0)) throw Error("invalid refund depth");
    }
    for (const r of this.data.refunds) {
      const fact = facts.find(f => f.group === r.group)!;
      r.seen = fact.seen; r.confirmations = fact.confirmations;
      if (r.seen === "mined" && r.confirmations >= 6) { r.refunded = r.principal; r.reserved = 0; }
      // A formerly settled transaction missing now reopens its exact reserve.
      // Unknown evidence invents neither settlement nor a proven reversal.
      else if (r.seen !== "unknown" && r.refunded > 0) { r.reserved = r.principal; r.refunded = 0; }
    }
    this.data.startupObserved = this.data.refunds.every(r => r.seen !== "unknown");
    this.data.revision++;
    return { ready: this.data.startupObserved,
      pending: this.data.refunds.filter(r => r.attempted && r.seen === "absent").map(r => r.group) };
  }
  retryRefund(group: string, txid: string, confirm: string, journalAcknowledged: boolean, fundingAvailable: boolean): { sent: boolean; bytes: string } {
    const r = this.data.refunds.find(r => r.group === group);
    if (!r || confirm !== group || txid !== r.txid) throw Error("exact refund confirmation required");
    if (!this.data.startupObserved || r.seen === "unknown") throw Error("refund observation required");
    if (r.seen === "mempool" || r.seen === "mined") return { sent: false, bytes: r.bytes };
    if (!r.attempted || !journalAcknowledged || !fundingAvailable) throw Error("refund retry unavailable");
    r.sendCalls++;
    // No accepted result is invented: the next observation resolves this send.
    r.seen = "unknown"; this.data.startupObserved = false; this.data.revision++;
    return { sent: true, bytes: r.bytes };
  }
}
