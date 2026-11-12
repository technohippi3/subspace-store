import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function qualification(repository: string, root: string, name: string) {
  const files = ["ts/src/bitcoin/rpc.ts", "ts/src/bitcoin/core.ts", "ts/src/bitcoin/validation.ts", "ts/src/bitcoin/refunds.ts",
    "ts/src/refunds/policy.ts", "ts/src/refunds/records.ts", "ts/src/refunds/types.ts", "ts/src/refunds/book.ts",
    "ts/src/application/store.ts", "ts/src/application/sales.ts", "ts/src/application/records.ts", "ts/regtest/core.test.ts", "ts/test/production/application-fixture.ts",
    "ts/src/bitcoin/refund-sender.ts", "ts/src/refunds/observations.ts", "ts/src/storage/journal.ts",
    "ts/src/refunds/families.ts", "ts/src/refunds/attempts.ts", "ts/src/bitcoin/exclusivity.ts", "ts/src/bitcoin/rebuild-funding.ts", "ts/src/application/monitor.ts",
    "ts/src/bitcoin/refund-estimate.ts", "ts/src/bitcoin/excess-fee.ts", "ts/src/application/assessments.ts",
    "ts/src/application/http.ts", "ts/src/application/operator-http.ts", "ts/src/application/authenticated-http.ts",
    "ts/src/application/pending-http.ts", "ts/src/application/entry.ts", "ts/src/application/registry.ts",
    "ts/src/application/bound-entries.ts", "ts/src/application/bound-records.ts", "ts/regtest/entry-lifecycle.ts",
    "ts/src/application/commitments.ts", "ts/src/application/commitment-records.ts", "ts/regtest/commitments.ts",
    "ts/src/application/certificate-cache.ts", "ts/src/application/certificate-records.ts", "ts/src/application/certificates.ts",
    "ts/src/application/certificate-http.ts", "ts/regtest/certificates.ts", "ts/regtest/qualification.ts",
    "ts/src/application/deliveries.ts", "ts/src/application/delivery-records.ts", "ts/src/application/delivery-http.ts", "ts/regtest/fulfillment.ts"];
  writeFileSync(join(root, "qualification.json"), JSON.stringify({ network: "regtest", core: "31.2.0", run: name,
    files: Object.fromEntries(files.map(path => [path, createHash("sha256").update(readFileSync(join(repository, path))).digest("hex")])),
    checks: ["payment", "conversion", "reorg", "spent-receipt", "descriptor-recovery-without-address-book",
      "replacement", "mempool-entry-time-preserved", "mempool-entry-height-reconstructed", "missing-mempool-without-rebroadcast",
      "refund-preparation-with-capped-buyer-fee", "refund-from-proven-order-change", "application-refund-send",
      "lost-refund-reply-and-store-restart", "refund-settlement-6-5-6", "deep-refund-reorg-and-remining",
      "refund-fee-bump-retains-inputs-and-buyer-output", "older-family-member-can-win-after-reorg", "rebuild-depends-on-settled-conflict",
      "conflict-ancestor-loss-invalidates-rebuild", "cancellation-deadline-after-earlier-excess-refund",
      "unsigned-fee-assessment-preserves-wallet-state", "unsigned-size-bounds-real-keypath-spend", "unsigned-fee-assessment-of-spent-receipt",
      "excess-deadline-before-preparation-and-distinct-cancellation", "excess-deadline-with-fee-coins-locked",
      "authenticated-operator-inspection-with-core", "cancelled-partial-invoice-stays-refund-only",
      "fresh-checkout-separates-late-old-payments", "registry-entry-acknowledgment-with-core",
      "registry-frozen-pending-acknowledgment", "registry-issuing-recheck-after-reorg", "bound-entry-idempotent-retry",
      "bound-entry-root-mismatch-refused", "bound-entry-restart-retains-binding", "bound-entry-closure-releases-once",
      "bound-entry-late-create-stays-closed", "bound-entry-arm-granted-once", "bound-entry-armed-close-refused",
      "bound-entry-lifecycle-restart", "commitment-depth-150-149-150", "commitment-anchor-gate-separate",
      "commitment-stale-tip-and-revision-refused", "commitment-report-restart", "certificate-cache-readiness-with-core",
      "certificate-ancestor-survives-extension", "certificate-reorg-withholds-cache",
      "certificate-new-verification-after-reorg", "certificate-restart-cache-continuity", "fulfilled-stickiness-core-reorg",
      "fulfilled-reverification-retains-first-receipt", "recovery-resolution-keeps-accounting", "fulfillment-restart-history",
      "no-certificate-on-fulfilled-checkpoint-loss"] }, null, 2), { mode: 0o600 });
}
