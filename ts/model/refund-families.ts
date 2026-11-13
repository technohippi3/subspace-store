// Independent ledger/transaction graph subset. No production imports.
// Core readiness and settled-conflict admission are runtime responsibilities.
export interface ModelTx { id: string; inputs: string[] }
interface Attempt { tx: string; charged: number }
interface Group { order: string; attempts: Attempt[] }
export class RefundFamilies {
  readonly transactions = new Map<string, ModelTx>();
  readonly confirmations = new Map<string, number>();
  readonly groups = new Map<string, Group>();
  readonly receipts = new Map<string, number>();
  readonly prices = new Map<string, number>();
  transaction(id: string, inputs: string[]): void {
    if (this.transactions.has(id) || new Set(inputs).size !== inputs.length) throw Error("duplicate transaction or input");
    this.transactions.set(id, { id, inputs: [...inputs] }); this.confirmations.set(id, 0);
  }
  exclusive(a: string, b: string): boolean {
    const left = this.transactions.get(a), right = this.transactions.get(b);
    if (!left || !right || a === b) return false;
    if (left.inputs.some(input => right.inputs.includes(input))) return true;
    const path = (root: ModelTx, other: ModelTx): boolean => {
      const queue = [...root.inputs], seen = new Set<string>();
      for (const input of queue) {
        const parentId = input.split(":")[0]!;
        if (seen.has(parentId)) continue; seen.add(parentId);
        const parent = this.transactions.get(parentId);
        if (!parent) continue;
        // A child of the other refund can confirm alongside it.
        if (parent.id !== other.id && parent.inputs.some(i => other.inputs.includes(i))) return true;
        queue.push(...parent.inputs);
      }
      return false;
    };
    return path(left, right) || path(right, left);
  }
  balances(order: string) {
    let reserved = 0, refunded = 0;
    for (const group of this.groups.values()) {
      if (group.order !== order) continue;
      const settled = group.attempts.filter(a => (this.confirmations.get(a.tx) ?? 0) >= 6);
      if (settled.length > 1) throw Error("two refunds paid one obligation");
      if (settled.length) refunded += settled[0]!.charged;
      else reserved += Math.max(...group.attempts.map(a => a.charged));
    }
    const available = (this.receipts.get(order) ?? 0) - (this.prices.get(order) ?? 0) - reserved - refunded;
    return { reserved, refunded, available };
  }
  open(group: string, order: string, tx: string, charged: number): void {
    this.amount(charged);
    if (this.groups.has(group) || !this.transactions.has(tx) || charged > this.balances(order).available) throw Error("new refund lacks credit");
    this.groups.set(group, { order, attempts: [{ tx, charged }] });
  }
  add(group: string, tx: string, charged: number): void {
    this.amount(charged);
    const g = this.groups.get(group); if (!g) throw Error("no group");
    if (g.attempts.some(a => (this.confirmations.get(a.tx) ?? 0) >= 6)) throw Error("group settled");
    if (!g.attempts.every(a => this.exclusive(a.tx, tx))) throw Error("replacement is not exclusive with every earlier attempt");
    const extra = Math.max(0, charged - Math.max(...g.attempts.map(a => a.charged)));
    if (extra > this.balances(g.order).available) throw Error("increase lacks credit");
    g.attempts.push({ tx, charged });
  }
  observe(tx: string, confirmations: number): void {
    if (!this.transactions.has(tx) || !Number.isSafeInteger(confirmations) || confirmations < 0) throw Error("invalid position");
    this.confirmations.set(tx, confirmations);
  }
  private amount(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw Error("invalid amount"); }
}
