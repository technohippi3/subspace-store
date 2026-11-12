import { armInput } from "./bound-records.ts";
import { summary, type CommitmentObservation } from "./commitment-records.ts";
import { CERTIFICATE_LIMIT, certificateHash } from "./certificate-cache.ts";
import { fail, whole, type State } from "./records.ts";
import { openRecovery, type recoveryReasons } from "./delivery-records.ts";

export interface CertificateRecord {
  version: 1; oid: string; entry: string; revision: number; root: string; height: number;
  hash: string; length: number; tipHeight: number; tipHash: string; valid: boolean; blockedThrough: number;
}
export interface ChainCheckpoint { tipHash: string; height: number; hash: string }
function fields(value: unknown, names: string): asserts value is { [key: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== names.split(",").sort().join()) fail("invalid certificate fields", "invalid");
}
function hash(value: unknown) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail("invalid certificate hash", "invalid"); }
export function certificateInput(value: unknown) {
  fields(value, "entry,root,oids,delegate,revision,oid,certificateRoot,certificateHeight,message_b64");
  const input = armInput({ entry: value.entry, root: value.root, oids: value.oids, delegate: value.delegate });
  whole(value.revision, 1); whole(value.certificateHeight); hash(value.certificateRoot);
  if (typeof value.oid !== "string" || !input.ids.includes(value.oid) || typeof value.message_b64 !== "string" ||
      !value.message_b64 || value.message_b64.length > 4 * Math.ceil(CERTIFICATE_LIMIT / 3) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value.message_b64)) fail("invalid certificate message", "invalid");
  const bytes = Buffer.from(value.message_b64, "base64");
  if (!bytes.length || bytes.length > CERTIFICATE_LIMIT || bytes.toString("base64") !== value.message_b64) fail("invalid certificate size or encoding", "invalid");
  return { ...input, oid: value.oid, revision: value.revision as number, rootBasis: value.certificateRoot as string,
    height: value.certificateHeight as number, bytes, hash: certificateHash(bytes) };
}
export function basisCovered(root: string, height: number, entryRoot: string, o: CommitmentObservation) {
  return summary(o).covered && (root === entryRoot ? height === o.minedHeight : height > o.minedHeight!) &&
    o.tipHeight - height >= 150 && o.anchorHeight! - height >= 144;
}
export function invalidateCertificate(state: State, cert: CertificateRecord, reason: typeof recoveryReasons[number] = "certificate_checkpoint_lost") {
  if (cert.valid) openRecovery(state, cert.oid, reason);
  cert.valid = false;
  cert.blockedThrough = Math.max(cert.blockedThrough, state.commitments.find(c => c.entry === cert.entry)!.revision);
  const order = state.orders.find(o => o.id === cert.oid)!;
  if (order.status === "ready") order.status = "issuing";
}
export function invalidateCommitmentCertificates(state: State, entry: string) {
  const report = state.commitments.find(c => c.entry === entry)!;
  const root = state.entries.find(e => e.id === entry)!.root;
  for (const cert of state.certificates.filter(c => c.entry === entry && c.valid))
    if (!basisCovered(cert.root, cert.height, root, report.observation)) invalidateCertificate(state, cert, "commitment_lost");
}
export function certificateRecord(value: unknown): asserts value is CertificateRecord {
  fields(value, "version,oid,entry,revision,root,height,hash,length,tipHeight,tipHash,valid,blockedThrough");
  if (value.version !== 1 || typeof value.oid !== "string" || !/^o[1-9][0-9]{0,15}$/.test(value.oid) ||
      typeof value.entry !== "string" || !/^[0-9a-f]{32}$/.test(value.entry) || typeof value.valid !== "boolean") fail("invalid certificate record");
  whole(value.revision, 1); whole(value.height); whole(value.length, 1); whole(value.tipHeight); whole(value.blockedThrough);
  hash(value.root); hash(value.hash); hash(value.tipHash);
  if (value.length as number > CERTIFICATE_LIMIT || (value.tipHeight as number) - (value.height as number) < 150 ||
      (value.valid && (value.revision as number) <= (value.blockedThrough as number)) ||
      (!value.valid && (value.blockedThrough as number) < (value.revision as number))) fail("invalid certificate bounds");
}
export function validateCertificates(state: State) {
  const seen = new Set<string>();
  for (const cert of state.certificates) {
    const entry = state.entries.find(e => e.id === cert.entry), order = state.orders.find(o => o.id === cert.oid);
    const report = state.commitments.find(c => c.entry === cert.entry);
    if (seen.has(cert.oid) || !entry?.bindings.some(b => b.id === cert.oid) || !order || !report || cert.revision > report.revision ||
        cert.blockedThrough > report.revision || !state.arms.some(a => a.id === cert.entry) ||
        (cert.valid && (!["ready", "fulfilled"].includes(order.status) || !basisCovered(cert.root, cert.height, entry.root, report.observation))) ||
        (!cert.valid && !["issuing", "fulfilled"].includes(order.status))) fail("invalid certificate relationship");
    seen.add(cert.oid);
  }
  if (state.orders.some(o => o.status === "ready" && !state.certificates.some(c => c.oid === o.id && c.valid))) fail("ready order has no certificate");
}
