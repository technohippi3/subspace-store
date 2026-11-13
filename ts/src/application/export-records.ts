import {canonicalHandle,validP2tr} from "../recipient.ts";
export type CertificateProfile = "spacecert-v1" | "spacemsg-0.4.4";
export interface CertificateCapability { hash: string; oid: string; binding: string; profile: CertificateProfile; artifactHash: string; expires: number; revoked: boolean }
export interface CapabilityLedger { version: 1; last: number; grants: CertificateCapability[] }
export const emptyCapabilityLedger = (): CapabilityLedger => ({ version: 1, last: 0, grants: [] });
export function validateCapabilityLedger(value: unknown): asserts value is CapabilityLedger {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "grants,last,version") throw Error("invalid capability ledger");
  const v = value as CapabilityLedger;
  if (v.version !== 1 || !Number.isSafeInteger(v.last) || v.last < 0 || !Array.isArray(v.grants)) throw Error("invalid capability ledger");
  const hashes = new Set<string>(), slots = new Set<string>();
  for (const g of v.grants) {
    if (!g || Object.keys(g).sort().join() !== "artifactHash,binding,expires,hash,oid,profile,revoked" ||
      !/^[0-9a-f]{64}$/.test(g.hash) || !/^[0-9a-f]{64}$/.test(g.artifactHash) ||
      !/^o[1-9][0-9]{0,15}$/.test(g.oid) || !(g.profile === "spacecert-v1" || g.profile === "spacemsg-0.4.4") || typeof g.binding !== "string" || g.binding.length > 2048 ||
      typeof g.revoked !== "boolean" || !Number.isSafeInteger(g.expires) || g.expires < 1 || hashes.has(g.hash) || slots.has(g.oid + ":" + g.profile)) throw Error("invalid capability ledger");
    let fields:unknown;try{fields=JSON.parse(g.binding);}catch{throw Error("invalid capability binding");}
    if(!Array.isArray(fields)||fields.length!==8||fields[0]!==g.oid||typeof fields[1]!=="string"||!/^[0-9a-f]{32}$/.test(fields[1])||
      !Number.isSafeInteger(fields[2])||fields[2]<1||![fields[3],fields[4]].every(h=>typeof h==="string"&&/^[0-9a-f]{64}$/.test(h))||
      !Number.isSafeInteger(fields[5])||fields[5]<0||!validP2tr(fields[6])||!canonicalHandle(fields[7]))throw Error("invalid capability binding");
    hashes.add(g.hash); slots.add(g.oid + ":" + g.profile);
  }
}
