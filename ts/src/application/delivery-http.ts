import type { IncomingMessage } from "node:http";
import { Effect } from "effect";
import { body } from "./http.ts";
import { ApplicationError } from "./records.ts";

export function deliveryBody(request: IncomingMessage, mode: "lookup" | "fulfill" | "resolve") {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request), number = '(?:0|[1-9][0-9]{0,15})', oid = '"o[1-9][0-9]{0,15}"';
    const string = String.raw`"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
    const field = mode === "resolve" ? `(?:"incident"\\s*:\\s*${number}|"resolution"\\s*:\\s*${string})` :
      `(?:"(?:entry|root|delegate|certificateHash|relayRoot|proofHash)"\\s*:\\s*"[0-9a-f:]{1,80}"|"oids"\\s*:\\s*\\[\\s*(?:${oid}(?:\\s*,\\s*${oid})*)?\\s*\\]|"oid"\\s*:\\s*${oid}|"(?:revision|relayHeight)"\\s*:\\s*${number})`;
    const count = mode === "resolve" ? 2 : mode === "lookup" ? 5 : 10;
    if (!new RegExp(`^\\s*\\{\\s*${Array(count).fill(field).join("\\s*,\\s*")}\\s*\\}\\s*$`).test(raw)) throw Error("invalid body");
    const value: unknown = JSON.parse(raw);
    // Exact domain keys + exact grammar field count also reject duplicates.
    return value;
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid delivery request" }) });
}
