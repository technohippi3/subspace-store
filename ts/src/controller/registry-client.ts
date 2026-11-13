import { Effect } from "effect";
import { checked, ControllerError, refuse } from "./errors.ts";
import { entryPayload, outpoint, type Batch } from "./records.ts";
import type { ArmReceipt, EntryReceipt, Lookup, OrderBinding, RegistryPort, Result } from "./ports.ts";
import { orderBinding } from "./rebuild-records.ts";
import { strictJson } from "./json.ts";

function shape(value: unknown, fields: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== fields.split(",").sort().join())
    refuse("invalid controller registry response fields", "invalid");
}
export function entryReceipt(value: unknown, b: Batch, lookup = false, arm = false): Lookup | ArmReceipt {
  if (lookup && value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).join() === "found" &&
      (value as { found: unknown }).found === false) return { found: false };
  shape(value, "found,entry,root,oids,phase,delegate,acknowledged,batchable" + (arm ? ",granted" : ""));
  if (value.found !== true || value.entry !== b.entry_key || value.root !== b.root || !Array.isArray(value.oids) ||
      value.oids.length !== b.members.length || value.oids.some((id, i) => id !== b.members[i]) ||
      typeof value.acknowledged !== "boolean" || typeof value.batchable !== "boolean" ||
      !["open", "closed", "armed"].includes(String(value.phase))) refuse("mismatched controller entry response", "invalid");
  if (value.phase === "armed" ? !outpoint(value.delegate) : value.delegate !== null)
    refuse("invalid controller entry delegate", "invalid");
  if (value.phase === "closed" && value.batchable) refuse("closed controller entry is batchable", "invalid");
  if (arm && (value.phase !== "armed" || value.delegate !== b.delegate_in || typeof value.granted !== "boolean" ||
      value.granted && !value.acknowledged)) refuse("invalid exclusive controller arm response", "invalid");
  return structuredClone(value) as unknown as EntryReceipt | ArmReceipt;
}
export class HttpRegistry implements RegistryPort {
  private readonly origin: string;
  private readonly credential: Result<string>;
  private readonly timeout: number;
  constructor(origin: string, credential: Result<string>, timeout = 30_000) {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        url.protocol === "http:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
        !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) refuse("invalid controller registry origin", "invalid");
    this.origin = url.origin; this.credential = credential; this.timeout = timeout;
  }
  private request(path: string, payload?: unknown): Result<unknown> {
    const self = this;
    return Effect.gen(function* () {
      const credential = yield* self.credential;
      return yield* Effect.tryPromise({ try: async () => {
        if (credential.length < 32 || credential.length > 4096 || /\s/.test(credential)) refuse("invalid controller operator credential", "invalid");
        const response = await fetch(self.origin + path, { method: payload === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(self.timeout),
          headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
        const chunks: Uint8Array[] = []; let size = 0;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) { const part = await reader.read(); if (part.done) break;
              size += part.value.length; if (size > 1024 * 1024) { await reader.cancel(); refuse("controller registry response too large", "invalid"); }
              chunks.push(part.value);
            }
          } finally { reader.releaseLock(); }
        }
        if (response.status !== 200) refuse("controller registry operation refused", response.status >= 500 ? "unavailable" : "refused");
        return strictJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      }, catch: error => error instanceof ControllerError ? error : new ControllerError({ code: "unavailable", message: "controller registry response unavailable" }) });
    });
  }
  lookup(b: Batch): Result<Lookup> {
    const self = this; return Effect.gen(function* () {
      const payload = yield* checked("entry payload", () => entryPayload(b));
      const value = yield* self.request("/operator/issuance-entries/lookup", payload);
      return yield* checked("validate entry receipt", () => entryReceipt(value, b, true));
    });
  }
  enter(b: Batch): Result<EntryReceipt> {
    const self = this; return Effect.gen(function* () {
      const payload = yield* checked("entry payload", () => entryPayload(b));
      const raw = yield* self.request("/operator/issuance-entries", payload);
      return yield* checked("validate created entry", () => {
        const value = entryReceipt(raw, b);
        if (!value.found) return refuse("controller entry creation returned absence", "invalid"); return value;
      });
    });
  }
  arm(b: Batch): Result<ArmReceipt> {
    const self = this; return Effect.gen(function* () {
      const payload = yield* checked("arm payload", () => ({ ...entryPayload(b), delegate: b.delegate_in }));
      const raw = yield* self.request("/operator/issuance-entries/arm", payload);
      return yield* checked("validate arm receipt", () => entryReceipt(raw, b, false, true) as ArmReceipt);
    });
  }
  close(b: Batch): Result<EntryReceipt> {
    const self = this; return Effect.gen(function* () {
      const payload = yield* checked("close payload", () => entryPayload(b));
      const raw = yield* self.request("/operator/issuance-entries/close", payload);
      return yield* checked("validate closure receipt", () => {
        const value = entryReceipt(raw, b);
        if (!value.found || value.phase !== "closed") refuse("controller entry was not closed; locks retained"); return value;
      });
    });
  }
  order(b: Batch, oid: string): Result<OrderBinding> {
    const self = this; return Effect.gen(function* () {
      yield* checked("validate requested member", () => { if (!b.members.includes(oid)) refuse("unknown controller member", "invalid"); });
      const value = yield* self.request(`/operator/orders/${oid}`);
      return yield* checked("validate order binding", () => orderBinding(value, b, oid));
    });
  }
  failing(b: Batch, issuing: boolean): Result<readonly string[]> {
    const self = this; return Effect.gen(function* () {
      const observed = yield* self.request("/operator/observe", {});
      yield* checked("validate observation", () => {
        shape(observed, "observed"); if (observed.observed !== true) refuse("controller observation not confirmed", "invalid");
      });
      const failed: string[] = [];
      for (const member of b.members) {
        const value = yield* self.request(`/operator/orders/${member}/batch-entry`, {});
        const valid = yield* checked("validate member recheck", () => {
          shape(value, "batch_entry,issuing_recheck");
          if (typeof value.batch_entry !== "boolean" || typeof value.issuing_recheck !== "boolean") refuse("invalid controller member recheck", "invalid");
          return value[issuing ? "issuing_recheck" : "batch_entry"];
        });
        if (!valid) failed.push(member);
      }
      return failed;
    });
  }
}
