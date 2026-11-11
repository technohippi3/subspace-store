import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Effect } from "effect";
import { ApplicationError, checked } from "./records.ts";
import type { SalesStore } from "./store.ts";
import { body, responseFor, send } from "./http.ts";

export type OperatorToken = Effect.Effect<string, ApplicationError>;
function validToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{32,256}$/.test(value))
    throw new ApplicationError({ code: "unavailable", message: "operator credential unavailable" });
}
function authorized(request: IncomingMessage, token: OperatorToken) {
  return Effect.gen(function* () {
    const count = request.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === "authorization").length;
    const header = request.headers.authorization;
    const match = typeof header === "string" && /^Bearer ([\x21-\x7e]{32,256})$/i.exec(header);
    if (count !== 1 || !match) return false;
    const expected = yield* token; yield* checked(() => validToken(expected));
    const digest = (value: string) => createHash("sha256").update(value).digest();
    return timingSafeEqual(digest(match[1]!), digest(expected));
  });
}
/** Separate loopback listener. Credentials are injected and fetched anew;
 * this module neither stores them nor emits them in responses or logs.
 * Issuance, pending batches, certificates and refund writes are absent. */
export function serveOperator(store: SalesStore, token: OperatorToken, port = 0) {
  return Effect.gen(function* () {
    const credential = token.pipe(Effect.mapError(() => new ApplicationError({ code: "unavailable", message: "operator credential unavailable" })));
    const initial = yield* credential; yield* checked(() => validToken(initial));
    return yield* Effect.acquireRelease(Effect.tryPromise({ try: async () => {
      const controllers = new Set<AbortController>(), pending = new Set<Promise<void>>();
      const server = createServer((request, response) => {
        const controller = new AbortController(); controllers.add(controller);
        response.on("close", () => { if (!response.writableEnded) controller.abort(); });
        const work = (async () => {
          try {
            const operation = Effect.gen(function* () {
              if (!(yield* authorized(request, credential))) return { code: 401, value: { error: "unauthorized" } };
              const raw = request.url ?? "";
              if (!raw.startsWith("/operator/") || raw.length > 1024) return { code: 404, value: { error: "not found" } };
              const url = new URL(raw, "http://127.0.0.1"), path = url.pathname;
              if (request.method === "GET" && path === "/operator/orders") {
                if ([...url.searchParams].length > 1 || [...url.searchParams.keys()].some(k => k !== "status"))
                  return { code: 400, value: { error: "invalid order filter" } };
                return { code: 200, value: yield* store.inspectionOrders(url.searchParams.get("status") ?? undefined) };
              }
              if (url.search) return { code: 404, value: { error: "not found" } };
              const order = /^\/operator\/orders\/(o[1-9][0-9]{0,15})$/.exec(path);
              if (request.method === "GET" && order) return { code: 200, value: yield* store.inspectionOrder(order[1]!) };
              if (request.method === "GET" && path === "/operator/status") return { code: 200, value: yield* store.operatorStatus() };
              if (request.method === "GET" && path === "/operator/alerts") return { code: 200, value: { alerts: (yield* store.operatorStatus()).alerts } };
              if (request.method === "POST" && path === "/operator/observe") {
                const rawBody = (yield* Effect.tryPromise({ try: () => body(request), catch: () => new ApplicationError({ code: "invalid", message: "invalid observation request" }) })).trim();
                if (rawBody !== "" && rawBody !== "{}") return { code: 400, value: { error: "invalid observation request" } };
                yield* store.observe(); return { code: 200, value: { observed: true } };
              }
              return { code: 404, value: { error: "not found" } };
            });
            const result = await Effect.runPromise(responseFor(operation), { signal: controller.signal });
            send(response, result.code, result.value);
          } catch { send(response, 503, { error: "service unavailable" }); }
        })();
        pending.add(work); void work.finally(() => { pending.delete(work); controllers.delete(controller); });
      });
      server.requestTimeout = 15_000; server.headersTimeout = 10_000;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const address = server.address(); if (!address || typeof address === "string") throw Error("operator listener unavailable");
      return { url: `http://127.0.0.1:${address.port}`, close: async () => {
        for (const controller of controllers) controller.abort();
        const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections();
        await Promise.allSettled([...pending]); await closed;
      } };
    }, catch: () => new ApplicationError({ code: "unavailable", message: "operator listener unavailable" }) }),
    listener => Effect.promise(listener.close));
  });
}
