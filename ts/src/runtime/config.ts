import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { Effect } from "effect";
import { ApplicationError, destination, sats, whole, type Destination } from "../application/records.ts";
import { policy, type RefundPolicy } from "../refunds/policy.ts";
import { BitcoinRpc } from "../bitcoin/rpc.ts";

export interface RuntimeConfig {
  version: 1; network: "regtest";
  database: string; journalDirectory: string;
  listen: { buyer: number; operator: number; subs: number };
  core: { url: string; cookiePath: string; wallet: string };
  credentials: { operator: string; subs: string };
  riskBudgetSats: number; refundPolicy: RefundPolicy;
  merchantDestinations: Destination[]; pollMilliseconds: number;
}
const invalid = () => new ApplicationError({ code: "invalid", message: "invalid regtest runtime configuration" });
function fields(value: unknown, names: string): asserts value is { [key: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== names.split(",").sort().join()) throw invalid();
}
function path(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || value.length > 4096) throw invalid();
}
export function configuration(value: unknown): RuntimeConfig {
  try {
    fields(value, "version,network,database,journalDirectory,listen,core,credentials,riskBudgetSats,refundPolicy,merchantDestinations,pollMilliseconds");
    if (value.version !== 1 || value.network !== "regtest") throw invalid();
    fields(value.listen, "buyer,operator,subs");
    for (const port of Object.values(value.listen)) { whole(port, 1); if (port > 65535) throw invalid(); }
    if (new Set(Object.values(value.listen)).size !== 3) throw invalid();
    fields(value.core, "url,cookiePath,wallet");
    path(value.database); path(value.journalDirectory); path(value.core.cookiePath);
    if (typeof value.core.url !== "string" || typeof value.core.wallet !== "string") throw invalid();
    new BitcoinRpc(value.core as RuntimeConfig["core"]);
    fields(value.credentials, "operator,subs"); path(value.credentials.operator); path(value.credentials.subs);
    const paths = [value.database, value.journalDirectory, value.core.cookiePath, value.credentials.operator, value.credentials.subs].map(p => resolve(p));
    if (new Set(paths).size !== paths.length || paths.some(p => p !== paths[1] && p.startsWith(paths[1]! + sep))) throw invalid();
    sats(value.riskBudgetSats); policy(value.refundPolicy); whole(value.pollMilliseconds, 100);
    if (value.pollMilliseconds > 60_000 || !Array.isArray(value.merchantDestinations)) throw invalid();
    const scripts = new Set<string>();
    for (const d of value.merchantDestinations) { fields(d, "address,script"); destination(d); if (scripts.has(d.script)) throw invalid(); scripts.add(d.script); }
    return structuredClone(value) as unknown as RuntimeConfig;
  } catch { throw invalid(); }
}
export function loadConfiguration(file: string) {
  return Effect.tryPromise({ try: async () => {
    const bytes = await readFile(file);
    if (bytes.length > 65_536) throw invalid();
    return configuration(JSON.parse(bytes.toString("utf8")) as unknown);
  }, catch: () => invalid() });
}
