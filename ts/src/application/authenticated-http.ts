import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Effect } from "effect";
import { ApplicationError, checked } from "./records.ts";
import { responseFor, send } from "./http.ts";

export interface Answer { code: number; value: unknown }
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

// One authenticated loopback transport; each role supplies its own route set
// and runtime credential provider. No credential is persisted or logged.
export function listenAuthenticated(route: (request: IncomingMessage) => Effect.Effect<Answer, unknown>, token: OperatorToken, port = 0) {
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
              return yield* route(request);
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
