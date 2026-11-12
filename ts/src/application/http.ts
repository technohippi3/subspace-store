import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Effect } from "effect";
import { ApplicationError } from "./records.ts";
import type { SalesStore } from "./store.ts";

// The recipient request has exactly two string members. Parsing that shape
// directly retains duplicate-key rejection, which JSON.parse alone loses.
const string = String.raw`"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const pair = `(${string})\\s*:\\s*(${string})`;
const requestShape = new RegExp(`^\\s*\\{\\s*${pair}\\s*,\\s*${pair}\\s*\\}\\s*$`);
const addressShape = new RegExp(`^\\s*\\{\\s*${pair}\\s*\\}\\s*$`);
function parseAddress(raw: string): string {
  const match = addressShape.exec(raw);
  if (!match || JSON.parse(match[1]!) !== "address") throw new ApplicationError({ code: "invalid", message: "invalid refund destination request" });
  try { JSON.parse(raw); return JSON.parse(match[2]!) as string; }
  catch { throw new ApplicationError({ code: "invalid", message: "invalid refund destination request" }); }
}
function parseRequest(raw: string): unknown {
  const match = requestShape.exec(raw);
  if (!match) throw new ApplicationError({ code: "invalid", message: "invalid recipient request" });
  const first: unknown = JSON.parse(match[1]!), second: unknown = JSON.parse(match[3]!);
  if (first === second) throw new ApplicationError({ code: "invalid", message: "repeated request member" });
  // JSON.parse also enforces JSON whitespace and escape rules.
  try { return JSON.parse(raw) as unknown; }
  catch { throw new ApplicationError({ code: "invalid", message: "invalid recipient request" }); }
}
export async function body(request: IncomingMessage, maximum = 65_536): Promise<string> {
  if (Number(request.headers["content-length"] ?? 0) > maximum)
    throw new ApplicationError({ code: "invalid", message: "body too large" });
  const parts: Buffer[] = []; let length = 0;
  for await (const data of request) {
    const part = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
    length += part.length;
    if (length > maximum) throw new ApplicationError({ code: "invalid", message: "body too large" });
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
}
export function send(response: ServerResponse, code: number, value: unknown): void {
  if (response.destroyed) return;
  const binary = Buffer.isBuffer(value), data = binary ? value : JSON.stringify(value);
  response.writeHead(code, { "Content-Type": binary ? "application/octet-stream" : "application/json", "Content-Length": Buffer.byteLength(data),
    ...(binary ? { "Content-Disposition": 'attachment; filename="certificate.message"' } : {}),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
  response.end(data);
}
/** Buyer JSON API only, bound to loopback for the future HTTPS proxy.
 * No operator, registry, wallet or public-listening interface. */
export function serve(store: SalesStore, port = 0) {
  return Effect.acquireRelease(Effect.tryPromise({ try: async () => {
    const controllers = new Set<AbortController>(), pending = new Set<Promise<void>>();
    const server = createServer((request, response) => {
      const controller = new AbortController(); controllers.add(controller);
      response.on("close", () => { if (!response.writableEnded) controller.abort(); });
      const work = (async () => {
        try {
          const path = request.url ?? "", method = request.method;
          const match = /^\/orders\/([A-Za-z0-9_-]{32})(\/(?:quote|cancel|refund-destination|certificate))?$/.exec(path);
          const operation: Effect.Effect<{ code: number; value: unknown }, unknown> = method === "POST" && path === "/requests" ?
            store.request(parseRequest(await body(request))).pipe(Effect.map(value => ({ code: 201, value }))) :
            match && method === "GET" && !match[2] ?
              store.order(match[1]!).pipe(Effect.map(value => ({ code: 200, value }))) :
            match && method === "GET" && match[2] === "/certificate" ?
              store.certificate(match[1]!).pipe(Effect.map(value => ({ code: 200, value }))) :
            match && method === "POST" && match[2] === "/quote" ?
              store.quote(match[1]!).pipe(Effect.map(value => ({ code: value.acknowledged ? 200 : 503, value }))) :
            match && method === "POST" && match[2] === "/cancel" ?
              store.cancel(match[1]!).pipe(Effect.map(value => ({ code: value.cancellation === "final" ? 200 : 202, value }))) :
            match && method === "POST" && match[2] === "/refund-destination" ?
              store.setRefundDestination(match[1]!, parseAddress(await body(request))).pipe(Effect.map(value => ({ code: 200, value }))) :
              Effect.succeed({ code: 404, value: { error: "not found" } });
          const answer = responseFor(operation);
          const result = await Effect.runPromise(answer, { signal: controller.signal });
          send(response, result.code, result.value);
        } catch (error) {
          if (error instanceof ApplicationError) send(response, 400, { error: error.message });
          else send(response, 503, { error: "service unavailable" });
        }
      })();
      pending.add(work);
      void work.finally(() => { pending.delete(work); controllers.delete(controller); });
    });
    server.requestTimeout = 15_000; server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("HTTP listener unavailable");
    return { url: `http://127.0.0.1:${address.port}`, close: async () => {
      for (const controller of controllers) controller.abort();
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.allSettled([...pending]);
      await closed;
    } };
  }, catch: () => new ApplicationError({ code: "unavailable", message: "HTTP listener unavailable" }) }),
  listener => Effect.promise(listener.close));
}
export function responseFor(operation: Effect.Effect<{ code: number; value: unknown }, unknown>) {
  return operation.pipe(Effect.match({ onSuccess: value => value,
    onFailure: error => ({ code: error instanceof ApplicationError ?
      ({ invalid: 400, refused: 409, unavailable: 503, not_found: 404 } as const)[error.code] : 503,
    value: { error: error instanceof ApplicationError ? error.message : "service unavailable" } }) }));
}
