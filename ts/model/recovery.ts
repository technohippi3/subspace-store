// Independent recovery oracle. No production imports, clock or network.
export interface RecoveredOrder {
  state: "requested" | "quoted" | "issuing" | "ready" | "fulfilled" | "cancelled";
  invoice: boolean; detection: "none" | "detected" | "unknown";
  certificate: boolean; receipt: string | null; reserve: number; incident: boolean;
}
export class RecoveryModel {
  readonly orders: RecoveredOrder[];
  paused = false;
  controllerRequired = true;
  constructor(orders: RecoveredOrder[]) { this.orders = orders; }
  prepare() {
    this.paused = true;
    for (const order of this.orders) {
      if (order.invoice && order.detection === "none") order.detection = "unknown";
      if (order.certificate && order.state === "fulfilled") order.incident = true;
      order.certificate = false;
      if (order.state === "ready") order.state = "issuing";
    }
  }
  observe(index: number, paid: boolean) { if (paid) this.orders[index]!.detection = "detected"; }
  snapshot() { return JSON.stringify(this); }
}
