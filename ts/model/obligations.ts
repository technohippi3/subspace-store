// Independent amount/deadline model. Inputs are spec facts, not store records.
export interface Debt { amount: number; left: number; start: number; sent: number | null; incident: boolean }
export class Obligations {
  readonly debts: Debt[] = [];
  readonly credited = new Map<string, number>();
  time = 0;
  evaluate(now: number, eligible: boolean, free: number,
           open: readonly { group: string; maximum: number }[],
           sent: readonly { group: string; amount: number; at?: number }[], excessFee?: number | null) {
    if (!Number.isSafeInteger(now) || now < this.time) throw Error("invalid time");
    this.time = now;
    const due = Math.max(0, free + open.reduce((n, g) => n + Math.max(0, g.maximum - (this.credited.get(g.group) ?? 0)), 0));
    const outstanding = this.debts.reduce((n, d) => n + d.left, 0);
    const minimumMet = excessFee === undefined || (excessFee !== null && due >= excessFee + 546);
    if (eligible && minimumMet && due > outstanding) this.debts.push({ amount: due - outstanding, left: due - outstanding, start: now, sent: null, incident: false });
    for (const receipt of sent) {
      let credit = Math.max(0, receipt.amount - (this.credited.get(receipt.group) ?? 0));
      this.credited.set(receipt.group, Math.max(receipt.amount, this.credited.get(receipt.group) ?? 0));
      for (const d of this.debts) {
        const at = Math.max(d.start, receipt.at ?? now), used = Math.min(d.left, credit);
        if (used && at - d.start > 86400) d.incident = true;
        d.left -= used; credit -= used;
        if (used && !d.left) d.sent = at;
      }
      // Surplus from an earlier refund is never credit against future debt.
    }
    for (const d of this.debts) if (d.left && now - d.start > 86400) d.incident = true;
    return structuredClone(this.debts);
  }
}

export class Deficits {
  readonly losses = new Map<string, number>();
  readonly active = new Set<string>();
  readonly alerts: { reason: string; amount: number }[] = [];
  evaluate(values: ReadonlyMap<string, number>) {
    for (const [reason, value] of values) {
      const uncovered = value - (this.losses.get(reason) ?? 0);
      if (uncovered > 0) {
        if (!this.active.has(reason)) this.alerts.push({ reason, amount: uncovered });
        this.active.add(reason);
      } else this.active.delete(reason);
    }
  }
  loss(reason: string, value: number) {
    if (value <= (this.losses.get(reason) ?? 0)) throw Error("no new loss");
    this.losses.set(reason, value); this.active.delete(reason);
  }
}
