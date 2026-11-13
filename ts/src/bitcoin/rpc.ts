import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Data, Effect } from "effect";

export class RpcError extends Data.TaggedError("RpcError")<{
  readonly method: string; readonly kind: "transport" | "protocol" | "rejected";
  readonly rpcCode: number | null; readonly message: string;
}> {}
export interface RpcConfig { readonly url: string; readonly cookiePath: string; readonly wallet?: string;
  readonly timeoutMs?: number; readonly maximumBytes?: number }
function error(method: string, kind: RpcError["kind"], rpcCode: number | null = null): RpcError {
  // Node errors may contain response bodies or credentials. Never propagate them.
  return new RpcError({ method, kind, rpcCode, message: `Bitcoin RPC ${method} failed (${kind})` });
}
function endpoint(config: RpcConfig): string {
  let url: URL;
  try { url = new URL(config.url); } catch { throw error("configuration", "protocol"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw error("configuration", "protocol");
  if (config.wallet !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.wallet)) throw error("configuration", "protocol");
    url.pathname = `/wallet/${encodeURIComponent(config.wallet)}`;
  }
  return url.href;
}
export class BitcoinRpc {
  private readonly config: RpcConfig;
  private readonly url: string;
  constructor(config: RpcConfig) {
    this.url = endpoint(config); this.config = { ...config };
    for (const n of [config.timeoutMs ?? 10_000, config.maximumBytes ?? 16_777_216])
      if (!Number.isSafeInteger(n) || n < 1) throw error("configuration", "protocol");
  }
  call(method: string, ...params: readonly unknown[]): Effect.Effect<unknown, RpcError> {
    const self = this;
    return Effect.tryPromise({ try: async signal => {
      if (!/^[a-z][a-z0-9]*$/.test(method)) throw error("configuration", "protocol");
      const cookie = (await readFile(self.config.cookiePath, "utf8")).trim();
      if (cookie.length > 4096 || !/^[^:\s]+:[^\s]+$/.test(cookie)) throw error(method, "transport");
      const id = randomUUID();
      const response = await fetch(self.url, { method: "POST", redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(self.config.timeoutMs ?? 10_000)]),
        headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(cookie).toString("base64") },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      const maximum = self.config.maximumBytes ?? 16_777_216;
      if (Number(response.headers.get("content-length") ?? 0) > maximum || !response.body) {
        await response.body?.cancel(); throw error(method, "protocol");
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.length;
          if (length > maximum) throw error(method, "protocol");
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"),
          (key: string, value: unknown, context?: { source?: string }) => {
            // Preserve Core's exact decoded-output BTC number before binary
            // floating point can round it. Node 24 supplies primitive sources.
            if (["value", "amount", "feerate"].includes(key) && typeof value === "number") {
              if (!context?.source) throw Error("numeric source unavailable");
              return context.source;
            }
            return value;
          });
      } catch { throw error(method, "protocol"); }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw error(method, "protocol");
      const reply = decoded as { id?: unknown; error?: unknown; result?: unknown };
      if (reply.id !== id) throw error(method, "protocol");
      if (reply.error !== null && reply.error !== undefined) {
        if ("result" in reply && reply.result !== null) throw error(method, "protocol");
        const code = (reply.error as { code?: unknown }).code;
        if (!Number.isSafeInteger(code)) throw error(method, "protocol");
        throw error(method, "rejected", code as number);
      }
      if (!response.ok || !("result" in reply)) throw error(method, "protocol");
      return reply.result;
    }, catch: cause => cause instanceof RpcError ? cause : error(method, "transport") });
  }
}
