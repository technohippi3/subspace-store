import type { State } from "./records.ts";

/** Same-database downtime cannot prove that an undiscovered invoice was unpaid.
 * This lifecycle barrier changes neither grants nor issuance/certificate facts. */
export function prepareStartupPause(state: State): void {
  state.settings.paused = true;
  const detected = new Set(state.payments.map(payment => payment.script));
  for (const order of state.orders) if (order.destination) {
    order.paymentHistory = order.paymentHistory === "detected" || detected.has(order.destination.script)
      ? "detected" : "unknown";
  }
}
