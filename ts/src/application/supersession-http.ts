import type { IncomingMessage } from "node:http";
import { Effect } from "effect";
import { ApplicationError } from "./records.ts";
import { body } from "./http.ts";

export function supersessionBody(request: IncomingMessage) {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request, 1_048_576), id = '"o[1-9][0-9]{0,15}"', number = '(?:0|[1-9][0-9]{0,15})';
    const field = `(?:"(?:entry|root|delegate|txid|conflictTxid|blockHash|tipHash|confirm)"\\s*:\\s*"[0-9a-f:]{1,80}"|"originalRaw"\\s*:\\s*"[0-9a-f]{2,800000}"|"(?:revision|height|tipHeight)"\\s*:\\s*${number}|"rootAbsent"\\s*:\\s*true|"oids"\\s*:\\s*\\[\\s*(?:${id}(?:\\s*,\\s*${id})*)?\\s*\\])`;
    if (!new RegExp(`^\\s*\\{\\s*${Array(14).fill(field).join("\\s*,\\s*")}\\s*\\}\\s*$`).test(raw)) throw Error("invalid body");
    const keys = [...raw.matchAll(/"([^"\\]*)"\s*:/g)].map(m => m[1]);
    if (new Set(keys).size !== keys.length) throw Error("duplicate fields");
    return JSON.parse(raw) as unknown;
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid confirmed supersession request" }) });
}
