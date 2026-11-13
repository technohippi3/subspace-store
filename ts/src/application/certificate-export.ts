import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Effect, Semaphore } from "effect";
import { emptyCapabilityLedger, type CapabilityLedger } from "./export-records.ts";

export class ExportError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
const missing = () => new ExportError(404, "certificate unavailable");
export const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const profiles = Object.freeze({
  "spacecert-v1": Object.freeze({ file: "certificate.spacecert", mediaType: "application/octet-stream", format: "libveritas-certificate-chain", containerVersion: 1, library: "libveritas-0.4.4" }),
  "spacemsg-0.4.4": Object.freeze({ file: "certificate.spacemsg", mediaType: "application/octet-stream", format: "libveritas-message", library: "libveritas-0.4.4" }),
});
export type Profile = keyof typeof profiles;
const supported = (p: unknown): p is Profile => typeof p === "string" && Object.hasOwn(profiles, p);
export function externalOrigin(raw: string, { allowLoopbackHttp = false } = {}) {
  let url: URL; try { url = new URL(raw); } catch { throw new ExportError(503, "trusted external origin unavailable"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || (allowLoopbackHttp && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
    throw new ExportError(503, "trusted external origin unavailable");
  return url.origin;
}
export interface ExportContext {
  oid: string; entry: string; revision: number; hash: string; root: string; height: number;
  recipient: string; handle: string; message: Uint8Array;
}
export interface ExportStore {
  certificateExportContext(token: string): Effect.Effect<ExportContext, unknown>;
  currentCertificateExport(oid: string): Effect.Effect<ExportContext, unknown>;
  readCertificateCapabilities(): Effect.Effect<CapabilityLedger, unknown>;
  saveCertificateCapabilities(before:CapabilityLedger, after:CapabilityLedger, current?:ExportContext): Effect.Effect<void,unknown>;
}
const binding = (c: ExportContext) => JSON.stringify([c.oid, c.entry, c.revision, c.hash, c.root, c.height, c.recipient, c.handle]);
interface ArtifactHash { hash: string; length: number }
type Hashes = Record<Profile, ArtifactHash>;
export interface NativeOptions {
  binary: string; directory: string; artifactManifest: string; anchorsFor: (context: ExportContext) => Promise<unknown>;
}
export class NativeArtifacts {
  readonly binary: string;
  readonly artifactManifest: string;
  readonly directory: string;
  anchorsFor: NativeOptions["anchorsFor"];
  private readonly expected = new Map<string, Hashes>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor({ binary, directory, anchorsFor, artifactManifest }: NativeOptions) {
    this.binary = binary; this.artifactManifest = artifactManifest; this.checkBinary();
    this.directory = directory; this.anchorsFor = anchorsFor; mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  checkBinary() {
    try {
      const manifest: unknown = JSON.parse(readFileSync(this.artifactManifest, "utf8"));
      if (!manifest || typeof manifest !== "object" || !("library" in manifest) || manifest.library !== "libveritas-0.4.4" ||
        !("binarySha256" in manifest) || manifest.binarySha256 !== digest(readFileSync(this.binary))) throw missing();
    } catch { throw new ExportError(503, "pinned native executable unavailable"); }
  }
  /** One native subprocess at a time and at most eight queued requests. */
  private async work<A>(run: () => Promise<A>): Promise<A> {
    if (this.pending >= 9) throw new ExportError(503, "native worker busy");
    this.pending++;
    const result = this.tail.then(run);
    this.tail = result.then(() => {}, () => {});
    try { return await result; } finally { this.pending--; }
  }
  artifact(context: ExportContext, profile: unknown) {
    if (!supported(profile)) return Promise.reject(new ExportError(404, "unsupported export profile"));
    return this.work(() => this.readArtifact(context, profile));
  }
  private async readArtifact(context: ExportContext, profile: Profile, repair=true):Promise<{bytes:Buffer;hash:string;file:string;mediaType:string;format:string;library:string}> {
    if (digest(context.message) !== context.hash) throw new ExportError(503, "certificate message binding differs");
    const key = digest(Buffer.from(binding(context))), dir = join(this.directory, key), stamp = join(dir, "export.json");
    // An on-disk cache stamp never authorizes itself. Reverify once per binding
    // in each process, then compare both cached bytes and metadata to that result.
    if (!this.expected.has(key)) {
      const temporary = join(this.directory, "." + randomBytes(16).toString("hex")); mkdirSync(temporary, { mode: 0o700 });
      try {
        writeFileSync(join(temporary, "message.bin"), context.message, { mode: 0o600 });
        writeFileSync(join(temporary, "anchors.json"), JSON.stringify(await this.anchorsFor(context)), { mode: 0o600 });
        const output = join(temporary, "native");
        this.checkBinary();
        await promisify(execFile)(this.binary, ["native", join(temporary, "message.bin"), join(temporary, "anchors.json"), context.handle,
          context.recipient, context.root, String(context.height), output], { maxBuffer: 2 * 1024 * 1024, timeout: 10000, killSignal: "SIGKILL" });
        const hashes = {} as Hashes;
        for (const name of Object.keys(profiles) as Profile[]) {
          const bytes = readFileSync(join(output, name === "spacecert-v1" ? "certificate.spacecert" : "roundtrip.spacemsg"));
          if (bytes.length < 1 || bytes.length > 1048576) throw new ExportError(503, "native artifact exceeds its bound");
          hashes[name] = { hash: digest(bytes), length: bytes.length };
          writeFileSync(join(temporary, profiles[name].file), bytes, { mode: 0o600 });
        }
        writeFileSync(join(temporary, "export.json"), JSON.stringify({ binding: binding(context), profiles: hashes }), { mode: 0o600 });
        this.expected.set(key, hashes);
        // Only the completed artifact directory is visible to later requests.
        try { renameSync(temporary, dir); } catch (error) { if (!existsSync(stamp)) throw error; }
      } catch { throw new ExportError(503, "native certificate export unavailable"); }
      finally { rmSync(temporary, { recursive: true, force: true }); }
    }
    try {
      const record = JSON.parse(readFileSync(stamp, "utf8")) as { binding: string; profiles: Hashes };
      if (record.binding !== binding(context)) throw missing();
      const bytes = readFileSync(join(dir, profiles[profile].file)), saved = record.profiles[profile], expected = this.expected.get(key)?.[profile];
      if (!expected || expected.hash !== saved.hash || expected.length !== saved.length) throw missing();
      if (bytes.length !== saved.length || digest(bytes) !== saved.hash) throw missing();
      return { bytes, hash: saved.hash, ...profiles[profile] };
    } catch {
      if(repair){this.expected.delete(key);rmSync(dir,{recursive:true,force:true});return this.readArtifact(context,profile,false);}
      throw new ExportError(503,"native artifact cache unavailable");
    }
  }
  qr(url: string): Promise<string> {
    return this.work(async () => {
      this.checkBinary();
      return new Promise<string>((resolve, reject) => {
        const child = spawn(this.binary, ["qr"], { stdio: ["pipe", "pipe", "pipe"] }); let output = "", size = 0;
        child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1048576) child.kill(); else output += chunk.toString(); });
        const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
        child.stderr.on("data", () => {});
        child.on("error", () => { clearTimeout(timer); reject(new ExportError(503, "QR unavailable")); });
        child.on("close", code => { clearTimeout(timer); code === 0 && size <= 1048576 ? resolve(output) : reject(new ExportError(503, "QR unavailable")); });
        child.stdin.on("error", () => {}); child.stdin.end(url);
      });
    });
  }
}
export interface ExportOptions {
  store: ExportStore; artifacts: NativeArtifacts; origin: string; clock: () => number;
  ttlSeconds: number; allowLoopbackHttp?: boolean;
}
export class CertificateExports {
  readonly origin: string; readonly store: ExportStore; artifacts: NativeArtifacts;
  readonly clock: () => number; readonly ttl: number; private saved: CapabilityLedger = emptyCapabilityLedger();
  private readonly queue = Semaphore.makeUnsafe(1);
  constructor({ store, artifacts, origin, clock, ttlSeconds, allowLoopbackHttp = false }: ExportOptions) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) throw new ExportError(503, "bounded explicit certificate token lifetime required");
    this.origin = externalOrigin(origin, { allowLoopbackHttp }); this.store = store; this.artifacts = artifacts; this.clock = clock; this.ttl = ttlSeconds;
  }
  private serial<A>(work: () => Promise<A>) { return Effect.runPromise(this.queue.withPermit(Effect.promise(work))); }
  private async confirmed() {
    try { const state = await Effect.runPromise(this.store.readCertificateCapabilities()); this.saved = structuredClone(state); return state; }
    catch { throw new ExportError(503,"capability journal acknowledgement unavailable"); }
  }
  private async persist(state:CapabilityLedger,current?:ExportContext) {
    try { await Effect.runPromise(this.store.saveCertificateCapabilities(this.saved,state,current)); this.saved=structuredClone(state); }
    catch { throw new ExportError(503,"capability mutation pending acknowledgement"); }
  }
  private async time(state: CapabilityLedger, n = this.clock()) {
    if (!Number.isSafeInteger(n) || n < state.last) throw new ExportError(503, "export clock unavailable");
    if (n > state.last) { state.last = n; await this.persist(state); } return n;
  }
  url(token: string, file: string) { return this.origin + "/c/" + token + "/" + file; }
  async current(oid: string): Promise<ExportContext> { try { return await Effect.runPromise(this.store.currentCertificateExport(oid)); } catch { throw missing(); } }
  async issue(orderToken: string, profile: unknown) {
    if (!supported(profile)) throw new ExportError(404, "unsupported export profile");
    let context: ExportContext; try { context = await Effect.runPromise(this.store.certificateExportContext(orderToken)); } catch { throw missing(); }
    const artifact = await this.artifacts.artifact(context, profile);
    return this.serial(async () => {
      const fresh = await this.current(context.oid); if (binding(fresh) !== binding(context)) throw missing();
      const state = await this.confirmed(), now = await this.time(state), token = randomBytes(32).toString("base64url"), expires = now + this.ttl;
      if (!Number.isSafeInteger(expires)) throw new ExportError(503, "export clock unavailable");
      state.grants = state.grants.filter(g => g.oid !== context.oid || g.profile !== profile);
      state.grants.push({ hash:digest(token),oid:context.oid,binding:binding(context),profile,artifactHash:artifact.hash,expires,revoked:false });
      await this.persist(state,context);
      return {token,profile,expires,url:this.url(token,profiles[profile].file),manifestUrl:this.url(token,"manifest.json"),qrUrl:this.url(token,"qr.svg")};
    });
  }
  private row(token: string) {
    return this.serial(async () => {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw missing();
      const state=await this.confirmed(),row=state.grants.find(g=>g.hash===digest(token));
      if (!row || row.revoked) throw missing();
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < state.last) throw new ExportError(503, "export clock unavailable");
      if (now >= row.expires) {
        // A known token may retire itself once. Persist before a final 404 so
        // a later clock rollback or host replay cannot revive observed expiry.
        state.last = now; row.revoked = true; await this.persist(state);
        throw missing();
      }
      await this.time(state, now); return row;
    });
  }
  async authorize(token: string) {
    const row = await this.row(token), context = await this.current(row.oid); if (binding(context) !== row.binding) throw missing(); return {row,context};
  }
  async download(token: string, requestedProfile: unknown) {
    const {row,context} = await this.authorize(token); if (requestedProfile !== row.profile) throw missing();
    const result = await this.artifacts.artifact(context,row.profile);
    if (result.hash !== row.artifactHash) throw new ExportError(503,"native artifact binding differs"); await this.authorize(token); return result;
  }
  async manifest(token: string) {
    const {row} = await this.authorize(token), artifact = await this.download(token,row.profile);
    return {version:1,profile:row.profile,format:artifact.format,library:artifact.library,mediaType:artifact.mediaType,
      filename:artifact.file,sha256:artifact.hash,expires:row.expires,url:this.url(token,artifact.file),compatibility:"native format; no Nacho app import claim"};
  }
  async qr(token: string) {
    const {row} = await this.authorize(token), result = await this.artifacts.qr(this.url(token,profiles[row.profile].file)); await this.authorize(token); return result;
  }
  async revokeAll(orderToken:string){
    let context:ExportContext;try{context=await Effect.runPromise(this.store.certificateExportContext(orderToken));}catch{throw missing();}
    return this.serial(async()=>{const state=await this.confirmed();await this.time(state);for(const row of state.grants)if(row.oid===context.oid)row.revoked=true;await this.persist(state);return {revoked:true as const};});
  }
  async revoke(orderToken: string, token: string) {
    let context: ExportContext; try { context = await Effect.runPromise(this.store.certificateExportContext(orderToken)); } catch { throw missing(); }
    return this.serial(async () => {
      const state = await this.confirmed(); await this.time(state); const row = state.grants.find(g => g.hash === digest(token));
      if (!row || row.oid !== context.oid) throw missing(); row.revoked = true; await this.persist(state); return {revoked:true as const};
    });
  }
}
export const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
export async function exportRoute(service: CertificateExports, request: IncomingMessage, response: ServerResponse) {
  const match = /^\/c\/([A-Za-z0-9_-]{43})\/(certificate\.spacecert|certificate\.spacemsg|manifest\.json|qr\.svg)$/.exec(request.url ?? "");
  try {
    if (request.method !== "GET" || !match) throw missing(); const token = match[1]!, name = match[2]!; let value: Buffer, type: string, attachment: string | undefined;
    if (name === "manifest.json") { value = Buffer.from(JSON.stringify(await service.manifest(token))); type = "application/json"; }
    else if (name === "qr.svg") { value = Buffer.from(await service.qr(token)); type = "image/svg+xml"; }
    else { const result = await service.download(token, name === "certificate.spacecert" ? "spacecert-v1" : "spacemsg-0.4.4"); value = result.bytes; type = result.mediaType; attachment = result.file; }
    response.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": value.length, ...(attachment ? { "Content-Disposition": `attachment; filename="${attachment}"` } : {}) }); response.end(value);
  } catch (error) {
    const code = error instanceof ExportError ? error.code : 503, value = Buffer.from(JSON.stringify({ error: code === 404 ? "not found" : "certificate export unavailable" }));
    response.writeHead(code, { ...headers, "Content-Type": "application/json", "Content-Length": value.length }); response.end(value);
  }
}
