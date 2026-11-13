import { Effect } from "effect";
import { armed } from "./commitment-records.ts";
import { basisCovered } from "./certificate-records.ts";
import { acknowledgedCertificate } from "./certificates.ts";
import { deliveryInput, resolutionInput, statusInput } from "./delivery-records.ts";
import { checked, fail } from "./records.ts";
import type { State } from "./records.ts";
import type { RegistryContext } from "./registry.ts";

export function recoveryView(c: RegistryContext, state: State, oid: string) {
  return Effect.gen(function* () {
    const incident = state.incidents.filter(i => i.oid === oid).at(-1);
    if (!incident) return null;
    const saved = yield* c.storage.acknowledged("recovery_incident", String(incident.id));
    const resolved = incident.resolution !== null && !!saved && JSON.stringify(saved.value) === JSON.stringify(incident) &&
      (yield* c.storage.confirm(saved.seq));
    return { open: !resolved, reasons: [...incident.reasons], resolution: resolved ? incident.resolution : null };
  });
}

/** The authenticated publisher attests verified relay inclusion, never mere
 * publication acceptance. No message send or cryptographic verifier here. */
export class Deliveries {
  private readonly c: RegistryContext;
  constructor(context: RegistryContext) { this.c = context; }
  status(value: unknown) {
    const c = this.c;
    return Effect.gen(function* () {
      const input = yield* checked(() => statusInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { state } = yield* c.refresh(); yield* checked(() => armed(state, input));
        const cert = state.certificates.find(v => v.oid === input.oid), report = state.commitments.find(v => v.entry === input.id);
        return { oid: input.oid, entry: input.id, revision: report?.revision ?? 0, certificateHash: cert?.hash ?? null,
          fulfilled: state.orders.find(o => o.id === input.oid)!.status === "fulfilled",
          acknowledged: yield* acknowledgedCertificate(c, state, input.oid) };
      }));
    });
  }
  fulfill(value: unknown) {
    const c = this.c;
    return Effect.gen(function* () {
      const input = yield* checked(() => deliveryInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { records, state, tipHash } = yield* c.refresh();
        const report = yield* checked(() => {
          armed(state, input);
          const report = state.commitments.find(v => v.entry === input.id) ?? fail("no delivery observation");
          const cert = state.certificates.find(v => v.oid === input.oid) ?? fail("no verified certificate");
          if (report.revision !== input.revision || report.observation.tipHash !== tipHash || report.observation.tipHeight !== state.settings.tip)
            fail("delivery observation changed; verify lookup again");
          if (!cert.valid || cert.entry !== input.id || cert.hash !== input.certificateHash ||
              !basisCovered(input.relayRoot, input.relayHeight, input.root, report.observation)) fail("delivery certificate/root is not current");
          return report;
        });
        if (!(yield* acknowledgedCertificate(c, state, input.oid))) return yield* checked(() => fail("delivery certificate not acknowledged", "unavailable"));
        yield* checked(() => {
          const order = state.orders.find(o => o.id === input.oid)!;
          if (order.status === "fulfilled") return; // Preserve the first delivery forever.
          if (order.status !== "ready") fail("order is not ready for delivery");
          state.fulfillments.push({ version: 1, oid: input.oid, entry: input.id, revision: input.revision,
            certificateHash: input.certificateHash, proofHash: input.proofHash, relayRoot: input.relayRoot, relayHeight: input.relayHeight,
            batchHeight: report.observation.minedHeight!, anchorHeight: report.observation.anchorHeight!,
            tipHeight: report.observation.tipHeight, tipHash: report.observation.tipHash });
          order.status = "fulfilled";
        });
        yield* c.save(records, state); yield* c.storage.flush();
        const f = state.fulfillments.find(v => v.oid === input.oid)!, saved = yield* c.storage.acknowledged("fulfillment", input.oid);
        return { oid: input.oid, entry: input.id, fulfilled: true,
          acknowledged: !!saved && JSON.stringify(saved.value) === JSON.stringify(f) && (yield* c.storage.confirm(saved.seq)) &&
            (yield* acknowledgedCertificate(c, state, input.oid)) };
      }));
    });
  }
  resolve(value: unknown) {
    const c = this.c;
    return Effect.gen(function* () {
      const input = yield* checked(() => resolutionInput(value));
      return yield* c.queue.withPermit(Effect.gen(function* () {
        const { records, state } = yield* c.load();
        const incident = yield* checked(() => {
          const incident = state.incidents.find(i => i.id === input.incident) ?? fail("no recovery incident", "not_found");
          if (incident.resolution !== null && incident.resolution !== input.resolution) fail("incident already has another resolution");
          incident.resolution = input.resolution; return incident;
        });
        yield* c.save(records, state); yield* c.storage.flush();
        const saved = yield* c.storage.acknowledged("recovery_incident", String(incident.id));
        return { incident: incident.id, resolution: incident.resolution,
          acknowledged: !!saved && JSON.stringify(saved.value) === JSON.stringify(incident) && (yield* c.storage.confirm(saved.seq)) };
      }));
    });
  }
}
