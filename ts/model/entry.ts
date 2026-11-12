// Independent, deterministic model of entry identity and atomic ownership.
// Payment and journal behavior are covered by their own models/integration tests.
interface Order { id: string; state: "converted" | "issuing" | "cancelled" }
interface Entry { key: string; root: string; orders: string[] }
export class EntryModel {
  private orders: Order[] = [];
  private entries: Entry[] = [];
  private closed: Entry[] = [];
  private armed: string[] = [];
  add(id: string) { this.orders.push({ id, state: "converted" }); }
  state(id: string) { return this.orders.find(o => o.id === id)!.state; }
  enter(key: string, root: string, members: string[]): void {
    if (!members.length || new Set(members).size !== members.length) throw Error("invalid membership");
    const ids = [...members].sort(), old = this.closed.find(e => e.key === key) ?? this.entries.find(e => e.key === key);
    if (old) {
      if (old.root !== root || old.orders.join() !== ids.join()) throw Error("identity conflict");
      return;
    }
    const orders = ids.map(id => this.orders.find(o => o.id === id));
    if (orders.some(o => !o || o.state !== "converted")) throw Error("not available");
    for (const order of orders) order!.state = "issuing";
    this.entries.push({ key, root, orders: ids });
  }
  close(key: string, root: string, members: string[]) {
    const ids = [...members].sort();
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !this.orders.some(o => o.id === id))) throw Error("invalid membership");
    const previous = this.closed.find(e => e.key === key) ?? this.entries.find(e => e.key === key);
    if (previous && (previous.root !== root || previous.orders.join() !== ids.join())) throw Error("identity conflict");
    if (this.armed.includes(key)) throw Error("armed");
    if (this.closed.some(e => e.key === key)) return;
    if (this.entries.some(e => e.key === key)) for (const id of ids) this.orders.find(o => o.id === id)!.state = "converted";
    this.closed.push({ key, root, orders: ids });
  }
  arm(key: string): boolean {
    if (this.closed.some(e => e.key === key)) throw Error("closed");
    if (!this.entries.some(e => e.key === key)) throw Error("missing");
    if (this.armed.includes(key)) return false;
    this.armed.push(key); return true;
  }
  cancel(id: string) {
    const order = this.orders.find(o => o.id === id)!;
    if (order.state === "issuing") throw Error("locked"); order.state = "cancelled";
  }
  snapshot() { return JSON.stringify({ orders: this.orders, entries: this.entries, closed: this.closed, armed: this.armed }); }
  static restore(data: string) {
    const value = JSON.parse(data) as { orders: Order[]; entries: Entry[]; closed: Entry[]; armed: string[] }, model = new EntryModel();
    model.orders = value.orders; model.entries = value.entries; model.closed = value.closed; model.armed = value.armed; return model;
  }
}
