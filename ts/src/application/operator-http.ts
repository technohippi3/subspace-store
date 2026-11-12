import { Effect } from "effect";
import { ApplicationError } from "./records.ts";
import type { SalesStore } from "./store.ts";
import { body } from "./http.ts";
import { listenAuthenticated, type OperatorToken } from "./authenticated-http.ts";
export type { OperatorToken } from "./authenticated-http.ts";

function empty(request: import("node:http").IncomingMessage) {
  return Effect.tryPromise({ try: async () => {
    const raw = (await body(request)).trim();
    if (raw !== "" && raw !== "{}") throw Error("invalid body");
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid empty request" }) });
}
function batch(request: import("node:http").IncomingMessage) {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request), id = '"o[1-9][0-9]{0,15}"';
    if (!new RegExp(`^\\s*\\{\\s*"oids"\\s*:\\s*\\[\\s*(?:${id}(?:\\s*,\\s*${id})*)?\\s*\\]\\s*\\}\\s*$`).test(raw)) throw Error("invalid body");
    return (JSON.parse(raw) as { oids: string[] }).oids;
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid batch request" }) });
}
function bound(request: import("node:http").IncomingMessage) {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request), id = '"o[1-9][0-9]{0,15}"';
    const array = `\\[\\s*(?:${id}(?:\\s*,\\s*${id})*)?\\s*\\]`;
    const field = `"(?:entry|root|oids)"\\s*:\\s*(?:"[0-9a-f]{1,64}"|${array})`;
    if (!new RegExp(`^\\s*\\{\\s*${field}\\s*,\\s*${field}\\s*,\\s*${field}\\s*\\}\\s*$`).test(raw)) throw Error("invalid body");
    return JSON.parse(raw) as unknown;
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid issuance entry request" }) });
}
/** Operator role only. The controller still owns roots, binding evidence,
 * broadcast intents, sends and recovery. No financial send is exposed. */
export function serveOperator(store: SalesStore, token: OperatorToken, port = 0) {
  return listenAuthenticated(request => Effect.gen(function* () {
    const raw = request.url ?? "";
    if (!raw.startsWith("/operator/") || raw.length > 1024) return { code: 404, value: { error: "not found" } };
    const url = new URL(raw, "http://127.0.0.1"), path = url.pathname;
    if (request.method === "GET" && path === "/operator/orders") {
      if ([...url.searchParams].length > 1 || [...url.searchParams.keys()].some(k => k !== "status"))
        return { code: 400, value: { error: "invalid order filter" } };
      const result = yield* store.inspectionOrders(url.searchParams.get("status") ?? undefined);
      return { code: 200, value: { orders: result.orders.map(o => o.oid) } };
    }
    if (url.search) return { code: 404, value: { error: "not found" } };
    const order = /^\/operator\/orders\/(o[1-9][0-9]{0,15})(\/(?:batch-entry|journal))?$/.exec(path);
    if (request.method === "GET" && order && !order[2]) return { code: 200, value: yield* store.inspectionOrder(order[1]!) };
    if (request.method === "GET" && path === "/operator/status") return { code: 200, value: yield* store.operatorStatus() };
    if (request.method === "GET" && path === "/operator/alerts") return { code: 200, value: { alerts: (yield* store.operatorStatus()).alerts } };
    if (request.method === "POST") {
      if (path === "/operator/issuance-entries") return { code: 200, value: yield* store.registry.entries.enter(yield* bound(request)) };
      if (path === "/operator/issuance-entries/lookup") return { code: 200, value: yield* store.registry.entries.find(yield* bound(request)) };
      if (path === "/operator/pending") return { code: 200, value: yield* store.registry.setPending(yield* batch(request)) };
      if (order?.[2]) {
        yield* empty(request);
        return { code: 200, value: yield* (order[2] === "/batch-entry" ? store.registry.entry(order[1]!) : store.registry.journal(order[1]!)) };
      }
      if (path === "/operator/observe") { yield* empty(request); yield* store.observe(); return { code: 200, value: { observed: true } }; }
    }
    return { code: 404, value: { error: "not found" } };
  }), token, port);
}
