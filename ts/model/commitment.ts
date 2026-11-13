// Independent deterministic oracle. No production records/reducers imported.
export class CommitmentModel {
  revision = 0;
  private facts: { mined: number | null; root: number | null; anchor: number | null; tip: number } | null = null;
  observe(previous: number, tip: number, mined: number | null, root: number | null, anchor: number | null) {
    const next = { mined, root, anchor, tip };
    if (previous + 1 === this.revision && JSON.stringify(next) === JSON.stringify(this.facts)) return;
    if (previous !== this.revision) throw Error("stale revision");
    this.revision++; this.facts = next;
  }
  phase() {
    if (!this.facts || this.facts.mined === null) return "broadcast";
    return this.facts.root === this.facts.mined && this.facts.tip - this.facts.mined >= 150 ? "final" : "mined";
  }
  covered() { return this.phase() === "final" && this.facts!.anchor !== null && this.facts!.anchor - this.facts!.mined! >= 144; }
  snapshot() { return JSON.stringify({ revision: this.revision, facts: this.facts }); }
  static restore(text: string) {
    const state = JSON.parse(text) as { revision: number; facts: CommitmentModel["facts"] }, model = new CommitmentModel();
    model.revision = state.revision; model.facts = state.facts; return model;
  }
}
