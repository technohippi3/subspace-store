// Independent, deterministic model of entry identity and atomic ownership.
// Payment and journal behavior are covered by their own models/integration tests.
interface Order { id: string; state: "converted" | "issuing" | "cancelled" }
interface Entry { key: string; root: string; orders: string[] }
export class EntryModel {
  private orders: Order[] = [];
  private entries: Entry[] = [];
  add(id: string) { this.orders.push({ id, state: "converted" }); }
  state(id: string) { return this.orders.find(o => o.id === id)!.state; }
  enter(key: string, root: string, members: string[]): void {
    if (!members.length || new Set(members).size !== members.length) throw Error("invalid membership");
    const ids = [...members].sort(), old = this.entries.find(e => e.key === key);
    if (old) {
      if (old.root !== root || old.orders.join() !== ids.join()) throw Error("identity conflict");
      return;
    }
    const orders = ids.map(id => this.orders.find(o => o.id === id));
    if (orders.some(o => !o || o.state !== "converted")) throw Error("not available");
    for (const order of orders) order!.state = "issuing";
    this.entries.push({ key, root, orders: ids });
  }
  cancel(id: string) {
    const order = this.orders.find(o => o.id === id)!;
    if (order.state === "issuing") throw Error("locked"); order.state = "cancelled";
  }
  snapshot() { return JSON.stringify({ orders: this.orders, entries: this.entries }); }
  static restore(data: string) {
    const value = JSON.parse(data) as { orders: Order[]; entries: Entry[] }, model = new EntryModel();
    model.orders = value.orders; model.entries = value.entries; return model;
  }
}
