// Independent deterministic fulfillment oracle; no runtime imports.
export class FulfillmentModel {
  state: "ready" | "fulfilled" = "ready";
  certificate = true;
  published = false;
  history: string | null = null;
  incidents: { resolved: boolean }[] = [];
  readonly priceReserve = 1000;
  deliver(proof: string, verified: boolean) {
    if (!this.published || !verified || !this.certificate) throw Error("not delivered");
    if (this.state !== "fulfilled") { this.state = "fulfilled"; this.history = proof; }
  }
  loseCertificate() {
    if (this.certificate && this.state === "fulfilled" && !this.incidents.some(i => !i.resolved)) this.incidents.push({ resolved: false });
    this.certificate = false;
  }
  verifyAgain() { this.certificate = true; }
  resolve() { const open = this.incidents.find(i => !i.resolved); if (!open) throw Error("no incident"); open.resolved = true; }
  snapshot() { return JSON.stringify(this); }
  static restore(text: string) { return Object.assign(new FulfillmentModel(), JSON.parse(text) as FulfillmentModel); }
}
