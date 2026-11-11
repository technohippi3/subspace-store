import { Effect } from "effect";
import type { SalesStore } from "./store.ts";
import { listenAuthenticated, type OperatorToken } from "./authenticated-http.ts";

/** Separate subs role and credential. Only the frozen pending set is served;
 * callback writes and finality are not implemented by this component. */
export function servePending(store: SalesStore, token: OperatorToken, port = 0) {
  return listenAuthenticated(request => Effect.gen(function* () {
    const raw = request.url ?? "";
    if (request.method !== "GET" || !raw.startsWith("/") || raw.length > 1024) return { code: 404, value: { error: "not found" } };
    const url = new URL(raw, "http://127.0.0.1");
    if (url.pathname === "/health" && !url.search) return { code: 200, value: { ok: true } };
    if (url.pathname !== "/pending") return { code: 404, value: { error: "not found" } };
    if ([...url.searchParams].length !== 1 || !url.searchParams.has("space")) return { code: 400, value: { error: "invalid space filter" } };
    return { code: 200, value: yield* store.registry.pendingFor(url.searchParams.get("space")!) };
  }), token, port);
}
