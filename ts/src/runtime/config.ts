import {backendReference,type RecoveryBackendReference} from "../storage/ssh-journal.ts";
import {externalOrigin} from "../application/certificate-export.ts";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { Effect } from "effect";
import { ApplicationError, destination, sats, whole, type Destination } from "../application/records.ts";
import { policy, type RefundPolicy } from "../refunds/policy.ts";
import { identity, type InstallationIdentity } from "../bitcoin/identity.ts";
import { BitcoinRpc } from "../bitcoin/rpc.ts";

export interface CertificateExportConfig { trustedOrigin:string;binary:string;artifactManifest:string;directory:string;ttlSeconds:number;spaced:{url:string;cookiePath:string} }
export interface RuntimeConfig {
  version: 1 | 2; network: "main" | "regtest";
  certificateExport?:CertificateExportConfig;
  recoveryBackend?:RecoveryBackendReference;
  maintenanceLock?: string;
  installation?: { genesis: string; descriptorHash: string };
  database: string; journalDirectory: string;
  listen: { buyer: number; operator: number; subs: number };
  core: { url: string; cookiePath: string; wallet: string };
  credentials: { operator: string; subs: string };
  riskBudgetSats: number; refundPolicy: RefundPolicy;
  merchantDestinations: Destination[]; pollMilliseconds: number;
}
const invalid = () => new ApplicationError({ code: "invalid", message: "invalid runtime configuration" });
function fields(value: unknown, names: string): asserts value is { [key: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== names.split(",").sort().join()) throw invalid();
}
function path(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || value.length > 4096) throw invalid();
}
export function configuration(value: unknown): RuntimeConfig {
  try {
    fields(value, "version,network,database,journalDirectory,listen,core,credentials,riskBudgetSats,refundPolicy,merchantDestinations,pollMilliseconds" +
      ((value as {version?:unknown})?.version === 2 ? ",installation,maintenanceLock" : "") +
      ((value as {version?:unknown;certificateExport?:unknown})?.version===2&&Object.hasOwn(value as object,"certificateExport")?",certificateExport":"") +
      ((value as {version?:unknown})?.version===2&&Object.hasOwn(value as object,"recoveryBackend")?",recoveryBackend":""));
    if (value.version === 1 ? value.network !== "regtest" : value.version !== 2 || (value.network !== "main" && value.network !== "regtest")) throw invalid();
    if (Object.hasOwn(value,"recoveryBackend")) backendReference(value.recoveryBackend);
    fields(value.listen, "buyer,operator,subs");
    for (const port of Object.values(value.listen)) { whole(port, 1); if (port > 65535) throw invalid(); }
    if (new Set(Object.values(value.listen)).size !== 3) throw invalid();
    fields(value.core, "url,cookiePath,wallet");
    path(value.database); path(value.journalDirectory); path(value.core.cookiePath);
    if (typeof value.core.url !== "string" || typeof value.core.wallet !== "string") throw invalid();
    new BitcoinRpc(value.core as RuntimeConfig["core"]);
    if (value.version === 2) { path(value.maintenanceLock); fields(value.installation, "genesis,descriptorHash"); expectedIdentity(value as unknown as RuntimeConfig); }
    if(value.certificateExport!==undefined){
      fields(value.certificateExport,"trustedOrigin,binary,artifactManifest,directory,ttlSeconds,spaced");
      const e=value.certificateExport; if(typeof e.trustedOrigin!=="string")throw invalid(); externalOrigin(e.trustedOrigin,{allowLoopbackHttp:value.network==="regtest"});
      for(const p of [e.binary,e.artifactManifest,e.directory])path(p);whole(e.ttlSeconds,1);if(e.ttlSeconds>86400)throw invalid();
      fields(e.spaced,"url,cookiePath");path(e.spaced.cookiePath);if(typeof e.spaced.url!=="string")throw invalid();new BitcoinRpc(e.spaced as unknown as RuntimeConfig["core"]);
    }
    fields(value.credentials, "operator,subs"); path(value.credentials.operator); path(value.credentials.subs);
    const paths = [value.database, value.journalDirectory, value.core.cookiePath, value.credentials.operator, value.credentials.subs, ...(value.version === 2 ? [value.maintenanceLock as string] : []),...(value.recoveryBackend ? Object.values(backendReference(value.recoveryBackend)).filter((v):v is string=>typeof v==="string") : []),...(value.certificateExport?[value.certificateExport.binary as string,value.certificateExport.artifactManifest as string,value.certificateExport.directory as string,(value.certificateExport.spaced as {cookiePath:string}).cookiePath]:[])].map(p => resolve(p));
    if (new Set(paths).size !== paths.length || paths.some(p => p !== paths[1] && p.startsWith(paths[1]! + sep))) throw invalid();
    if(value.certificateExport){const cache=resolve(value.certificateExport.directory as string);if(paths.some(p=>p!==cache&&(p.startsWith(cache+sep)||cache.startsWith(p+sep))))throw invalid();}
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

export function expectedIdentity(config: RuntimeConfig): InstallationIdentity | undefined {
  return config.version === 2 ? identity({version:1, network:config.network, wallet:config.core.wallet, ...config.installation}) : undefined;
}
