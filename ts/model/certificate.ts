// Deterministic reference state, without production imports or file/RPC work.
export class CertificateModel {
  revision = 0;
  blocked = 0;
  ready = false;
  covered = false;
  checkpoint: string | null = null;
  readonly priceReserve = 1000;
  observe(covered: boolean) { this.revision++; this.covered = covered; if (!covered) this.invalidate(); }
  verify(revision: number, tip: string) {
    if (revision !== this.revision || revision <= this.blocked || !this.covered) throw Error("reverify");
    this.ready = true; this.checkpoint = tip;
  }
  read(activeAncestors: Set<string>) {
    if (this.ready && !activeAncestors.has(this.checkpoint!)) this.invalidate();
    return this.ready;
  }
  private invalidate() { this.ready = false; this.blocked = this.revision; }
  snapshot() { return JSON.stringify(this); }
  static restore(text: string) { return Object.assign(new CertificateModel(), JSON.parse(text) as CertificateModel); }
}
