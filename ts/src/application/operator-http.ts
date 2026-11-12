import { Effect } from "effect";
import { ApplicationError } from "./records.ts";
import type { SalesStore } from "./store.ts";
import { body } from "./http.ts";
import { listenAuthenticated, type OperatorToken } from "./authenticated-http.ts";
import { certificateBody } from "./certificate-http.ts";
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
function bound(request: import("node:http").IncomingMessage, arm = false) {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request), id = '"o[1-9][0-9]{0,15}"';
    const array = `\\[\\s*(?:${id}(?:\\s*,\\s*${id})*)?\\s*\\]`;
    const field = `"(?:entry|root|oids${arm ? "|delegate" : ""})"\\s*:\\s*(?:"[0-9a-f]{1,64}(?::[0-9]{1,10})?"|${array})`;
    const fields = Array(arm ? 4 : 3).fill(field).join("\\s*,\\s*");
    if (!new RegExp(`^\\s*\\{\\s*${fields}\\s*\\}\\s*$`).test(raw)) throw Error("invalid body");
    return JSON.parse(raw) as unknown;
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid issuance entry request" }) });
}
function commitment(request: import("node:http").IncomingMessage) {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request), keys = new Set<string>();
    const number = '(?:0|[1-9][0-9]{0,15})', hash = '"[0-9a-f]{64}"', id = '"o[1-9][0-9]{0,15}"';
    const fact = `(?:"(?:txid|tipHash)"\\s*:\\s*${hash}|"(?:tipHeight|minedHeight|rootHeight|anchorHeight)"\\s*:\\s*(?:${number}|null))`;
    const observed = `\\{\\s*${Array(6).fill(fact).join("\\s*,\\s*")}\\s*\\}`;
    const field = `(?:"(?:entry|root|delegate)"\\s*:\\s*"[0-9a-f:]{1,80}"|"oids"\\s*:\\s*\\[\\s*(?:${id}(?:\\s*,\\s*${id})*)?\\s*\\]|"expectedRevision"\\s*:\\s*${number}|"observation"\\s*:\\s*${observed})`;
    if (!new RegExp(`^\\s*\\{\\s*${Array(6).fill(field).join("\\s*,\\s*")}\\s*\\}\\s*$`).test(raw)) throw Error("invalid body");
    // The grammar excludes escapes; JSON.parse cannot hide duplicate keys.
    const key = /"([^"\\]*)"\s*:/g;
    for (const match of raw.matchAll(key)) { if (keys.has(match[1]!)) throw Error("duplicate field"); keys.add(match[1]!); }
    return JSON.parse(raw) as unknown;
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid commitment request" }) });
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
      if (path === "/operator/certificates") return { code: 200, value: yield* store.registry.certificates.accept(yield* certificateBody(request)) };
      if (path === "/operator/commitments/lookup") return { code: 200, value: yield* store.registry.commitments.current(yield* bound(request, true)) };
      if (path === "/operator/commitments") return { code: 200, value: yield* store.registry.commitments.observe(yield* commitment(request)) };
      if (path === "/operator/issuance-entries") return { code: 200, value: yield* store.registry.entries.enter(yield* bound(request)) };
      if (path === "/operator/issuance-entries/lookup") return { code: 200, value: yield* store.registry.entries.find(yield* bound(request)) };
      if (path === "/operator/issuance-entries/close") return { code: 200, value: yield* store.registry.entries.close(yield* bound(request)) };
      if (path === "/operator/issuance-entries/arm") return { code: 200, value: yield* store.registry.entries.arm(yield* bound(request, true)) };
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
