import { Effect } from "effect";
import { Anchors, Message, QueryContext, Veritas, VERIFY_DEFAULT } from "@spacesprotocol/libveritas";
import { ControllerError } from "./errors.ts";
import type { Result } from "./ports.ts";

export interface VerifiedZone {
  readonly handle: string;
  readonly canonical: string;
  readonly script_pubkey: string;
  readonly sovereignty: "sovereign" | "pending" | "dependent";
  readonly commitment: { readonly status: "exists"; readonly root: string; readonly height: number } |
    { readonly status: "empty" | "unknown" };
}
export interface VerifiedCertificateMessage {
  readonly newestAnchor: number;
  readonly zones: readonly VerifiedZone[];
  readonly certificates: readonly Uint8Array[];
}
const hex32 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const height = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 4294967295;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid verifier facts");
  return value as Record<string, unknown>;
}
function zone(value: unknown): VerifiedZone {
  const row = object(value), commitment = object(row.commitment);
  if (typeof row.handle !== "string" || !row.handle.length || typeof row.canonical !== "string" || !row.canonical.length ||
      typeof row.script_pubkey !== "string" || !/^[0-9a-f]+$/.test(row.script_pubkey) || row.script_pubkey.length % 2 ||
      !["sovereign", "pending", "dependent"].includes(String(row.sovereignty))) throw Error("invalid verifier zone");
  let fact: VerifiedZone["commitment"];
  if (commitment.status === "exists") {
    const onchain = object(object(commitment.value).onchain);
    if (!hex32(onchain.state_root) || !height(onchain.block_height)) throw Error("invalid verifier commitment");
    fact = { status: "exists", root: onchain.state_root, height: onchain.block_height };
  } else if (commitment.status === "empty" || commitment.status === "unknown") {
    fact = { status: commitment.status };
  } else throw Error("invalid verifier commitment state");
  return { handle: row.handle, canonical: row.canonical, script_pubkey: row.script_pubkey,
    sovereignty: row.sovereignty as VerifiedZone["sovereignty"], commitment: fact };
}

/** Offline cryptographic facts only. The caller supplies independently trusted
 * anchors; this result does not establish active-chain freshness, delivery or
 * any operation/send authority. No runtime entrypoint selects this adapter. */
export function verifyCertificateMessage(bytes: Uint8Array, trustedAnchorsJson: string): Result<VerifiedCertificateMessage> {
  return Effect.try({ try: () => {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 1048576 ||
        typeof trustedAnchorsJson !== "string" || Buffer.byteLength(trustedAnchorsJson) > 1048576)
      throw Error("certificate inputs exceed bounds");
    const input: unknown = JSON.parse(trustedAnchorsJson);
    if (!Array.isArray(input) || !input.length || input.length > 512) throw Error("bounded trusted anchors required");
    // Use the official Node export and its production defaults. No dev/SNARK
    // option, custom bindings or alternative native fallback is supplied.
    if (VERIFY_DEFAULT() !== 0) throw Error("unexpected verification options");
    using anchors = new Anchors(trustedAnchorsJson);
    using verifier = new Veritas(anchors);
    using context = new QueryContext();
    using message = new Message(bytes);
    using verified = verifier.verifyWithOptions(context, message, VERIFY_DEFAULT());
    const raw: unknown = verified.zones();
    if (!Array.isArray(raw) || !raw.length || raw.length > 10000) throw Error("bounded verified zones required");
    const zones = raw.map(zone);
    if (new Set(zones.map(value => value.handle)).size !== zones.length) throw Error("duplicate verified zone");
    const certificates = verified.certificates().map(value => new Uint8Array(value));
    if (!certificates.length || certificates.length > 10000 || certificates.some(value => !value.length || value.length > 1048576))
      throw Error("bounded verified certificates required");
    const newestAnchor = verifier.newestAnchor();
    if (!height(newestAnchor)) throw Error("invalid newest anchor");
    return { newestAnchor, zones, certificates };
  }, catch: () => new ControllerError({ code: "invalid", message: "certificate verification refused" }) });
}
