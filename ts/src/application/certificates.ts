import { Effect } from "effect";
import { armed } from "./commitment-records.ts";
import { basisCovered, certificateInput, invalidateCertificate, type ChainCheckpoint } from "./certificate-records.ts";
import { checked, fail, type ApplicationError, type Snapshot, type State } from "./records.ts";
import type { RegistryContext } from "./registry.ts";

export type CertificateChain = (checkpoint: ChainCheckpoint) => Effect.Effect<boolean, ApplicationError>;
/** A descendant of the verification tip preserves the verified roots and
 * anchors. A lost checkpoint requires a new observation and verification. */
export function checkCertificates(state: State, snapshot: Snapshot, chain: CertificateChain | undefined) {
  return Effect.gen(function* () {
    if (state.certificates.length && !chain) return yield* checked(() => fail("certificate chain adapter is required", "unavailable"));
    const checkpoints = new Map<string, boolean>();
    for (const cert of state.certificates.filter(c => c.valid)) {
      if (!snapshot.tipHash) return yield* checked(() => fail("certificate chain tip unavailable", "unavailable"));
      const key = `${cert.tipHeight}:${cert.tipHash}`;
      let current = checkpoints.get(key);
      if (current === undefined) { current = yield* chain!({ tipHash: snapshot.tipHash, height: cert.tipHeight, hash: cert.tipHash }); checkpoints.set(key, current); }
      if (!current) invalidateCertificate(state, cert);
    }
  });
}
export function acknowledgedCertificate(c: RegistryContext, state: State, oid: string) {
  return Effect.gen(function* () {
    const cert = state.certificates.find(v => v.oid === oid);
    if (!cert?.valid || state.orders.find(o => o.id === oid)?.status !== "ready") return false;
    const commitment = state.commitments.find(v => v.entry === cert.entry)!;
    const entry = state.entries.find(v => v.id === cert.entry)!, arm = state.arms.find(v => v.id === cert.entry)!;
    const order = state.orders.find(o => o.id === oid)!;
    yield* c.storage.flush();
    for (const [kind, key, value] of [["certificate", oid, cert], ["commitment", cert.entry, commitment],
      ["issuance_entry", cert.entry, entry], ["entry_arm", cert.entry, arm], ["sales_order", oid, order]] as const) {
      const saved = yield* c.storage.acknowledged(kind, key);
      if (!saved || JSON.stringify(saved.value) !== JSON.stringify(value) || !(yield* c.storage.confirm(saved.seq))) return false;
    }
    return true;
  });
}
/** Caller holds the application queue and has refreshed chain evidence. */
export function certificateBytes(c: RegistryContext, state: State, oid: string) {
  return Effect.gen(function* () {
    if (!(yield* acknowledgedCertificate(c, state, oid))) return null;
    const cert = state.certificates.find(v => v.oid === oid)!;
    return yield* c.certificateCache.get(cert.hash, cert.length);
  });
}
export class Certificates {
  private readonly context: RegistryContext;
  constructor(context: RegistryContext) { this.context = context; }
  accept(value: unknown) {
    const c = this.context;
    return Effect.gen(function* () {
      const input = yield* checked(() => certificateInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { records, state, tipHash } = yield* c.refresh();
        const report = yield* checked(() => {
          armed(state, input);
          if (!c.certificateChain) fail("certificate chain adapter is required", "unavailable");
          const report = state.commitments.find(v => v.entry === input.id) ?? fail("no commitment observation");
          if (report.revision !== input.revision || report.observation.tipHash !== tipHash || report.observation.tipHeight !== state.settings.tip)
            fail("certificate observation changed; reverify");
          if (!basisCovered(input.rootBasis, input.height, input.root, report.observation)) fail("certificate root is not final and covered");
          const previous = state.certificates.find(v => v.oid === input.oid);
          if (input.revision <= (previous?.blockedThrough ?? 0)) fail("certificate was invalidated; observe and reverify");
          const order = state.orders.find(o => o.id === input.oid)!;
          if (!["issuing", "ready"].includes(order.status)) fail("order is not certifiable");
          return report;
        });
        yield* c.certificateCache.put(input.bytes);
        yield* checked(() => {
          const previous = state.certificates.find(v => v.oid === input.oid);
          const cert = { version: 1 as const, oid: input.oid, entry: input.id, revision: input.revision,
            root: input.rootBasis, height: input.height, hash: input.hash, length: input.bytes.length,
            tipHeight: report.observation.tipHeight, tipHash: report.observation.tipHash, valid: true,
            blockedThrough: previous?.blockedThrough ?? 0 };
          if (previous) Object.assign(previous, cert); else state.certificates.push(cert);
          state.orders.find(o => o.id === input.oid)!.status = "ready";
        });
        yield* c.save(records, state);
        return { oid: input.oid, entry: input.id, revision: input.revision, certificateRoot: input.rootBasis,
          certificateHeight: input.height, hash: input.hash, length: input.bytes.length,
          acknowledged: yield* acknowledgedCertificate(c, state, input.oid) };
      }));
    });
  }
}
