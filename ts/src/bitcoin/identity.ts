import { createHash } from "node:crypto";

export const GENESIS = {
  main: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
  regtest: "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206",
} as const;
export interface InstallationIdentity {
  version: 1;
  network: keyof typeof GENESIS;
  genesis: string;
  wallet: string;
  descriptorHash: string;
}
const unavailable = (): never => { throw Error("installation network or payment wallet identity differs; inspect configuration and recovery material"); };
export function identity(value: unknown): InstallationIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== "descriptorHash,genesis,network,version,wallet" ||
      v.version !== 1 || (v.network !== "main" && v.network !== "regtest") ||
      v.genesis !== GENESIS[v.network] || typeof v.wallet !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v.wallet) ||
      typeof v.descriptorHash !== "string" || !/^[0-9a-f]{64}$/.test(v.descriptorHash)) return unavailable();
  return { version: 1, network: v.network, genesis: v.genesis as string,
    wallet: v.wallet, descriptorHash: v.descriptorHash };
}
/** Public descriptor expressions identify keys; mutable scan ranges do not.
 * No descriptor, key, cookie or RPC response is included in an error. */
export function descriptorFingerprint(reply: unknown): string {
  if (!reply || typeof reply !== "object" || !Array.isArray((reply as { descriptors?: unknown }).descriptors)) return unavailable();
  const rows = (reply as { descriptors: unknown[] }).descriptors;
  if (!rows.length || rows.length > 1000) return unavailable();
  const expressions = rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return unavailable();
    const desc = (row as { desc?: unknown }).desc;
    if (typeof desc !== "string" || !desc || desc.length > 16384 || /[\x00-\x1f\x7f]/.test(desc)) return unavailable();
    return desc;
  }).sort();
  if (new Set(expressions).size !== expressions.length) return unavailable();
  return createHash("sha256").update(JSON.stringify(expressions)).digest("hex");
}
/** Old unbound history is the explicitly regtest-only baseline. It cannot be
 * reinterpreted as a fresh mainnet installation by changing configuration. */
export function bindIdentity(previous: unknown | null, observed: unknown, hasHistory: boolean): InstallationIdentity {
  const next = identity(observed);
  if (previous === null) {
    if (hasHistory && next.network !== "regtest") return unavailable();
    return next;
  }
  const saved = identity(previous);
  if (JSON.stringify(saved) !== JSON.stringify(next)) return unavailable();
  return saved;
}

/** Configuration checks apply even to offline restore and version-1 callers. */
export function checkStoredIdentity(previous: InstallationIdentity | null, network: "main" | "regtest" | undefined,
  expected: InstallationIdentity | undefined, hasHistory: boolean): void {
  if (network === undefined) return;
  if (previous) {
    if (previous.network !== network) unavailable();
    if (expected) bindIdentity(previous, expected, hasHistory);
  } else if (network === "main" && hasHistory) unavailable();
}
