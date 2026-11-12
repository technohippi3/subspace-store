// Independent deterministic oracle. No production reducers, RPCs or wall clock.
export class SupersessionModel {
  orders: { status: "issuing" | "converted" | "cancelled" | "fulfilled"; elsewhere: boolean; incident: boolean }[];
  proof: "none" | "active" | "revoked" = "none";
  replacement: "converted" | "issuing" | null = null;
  get replacementBlocked() { return this.replacement !== null && this.proof !== "active"; }
  get priceReserve() { return this.orders[0]!.status === "cancelled" ? 0 : 1000; }
  constructor(fulfilled = false) {
    this.orders = [ { status: fulfilled ? "fulfilled" : "issuing", elsewhere: false, incident: false } ];
  }
  acknowledge(conflict: boolean, confirmations: number, rootAbsent: boolean, ownerConfirmed: boolean, fresh = false) {
    if (this.proof !== "none" && (this.proof !== "revoked" || !fresh || this.orders.some(o => o.elsewhere || o.status === "cancelled"))) throw Error("new explicit observation needed");
    if (!conflict || confirmations < 6 || !rootAbsent || !ownerConfirmed) throw Error("not safe supersession");
    this.proof = "active";
    for (const o of this.orders) {
      if (o.status === "fulfilled") o.incident = true;
      else o.status = "converted";
    }
  }
  loseCheckpoint() {
    if (this.proof !== "active") return;
    this.proof = "revoked";
    for (const o of this.orders) {
      if (o.status === "converted" && !o.elsewhere) o.status = "issuing";
      else o.incident = true;
    }
  }
  cancel() { if (this.orders[0]!.status !== "converted") throw Error("not cancellable"); this.orders[0]!.status = "cancelled"; }
  rebatch() { if (this.proof !== "active" || this.orders[0]!.status !== "converted") throw Error("not batchable"); this.orders[0]!.status = "issuing"; this.orders[0]!.elsewhere = true; }
  newCheckout() { if (this.orders[0]!.status !== "cancelled") throw Error("name claimed"); this.replacement = "converted"; }
  issueReplacement() { if (this.replacement !== "converted" || this.replacementBlocked) throw Error("old issuance unresolved"); this.replacement = "issuing"; }
  snapshot() { return JSON.stringify(this); }
  static restore(text: string) { return Object.assign(new SupersessionModel(), JSON.parse(text) as SupersessionModel); }
}
