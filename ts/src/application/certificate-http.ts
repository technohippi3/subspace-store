import type { IncomingMessage } from "node:http";
import { Effect } from "effect";
import { body } from "./http.ts";
import { ApplicationError } from "./records.ts";
import { CERTIFICATE_LIMIT } from "./certificate-cache.ts";

export function certificateBody(request: IncomingMessage) {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request, 4 * Math.ceil(CERTIFICATE_LIMIT / 3) + 65_536);
    const number = '(?:0|[1-9][0-9]{0,15})', id = '"o[1-9][0-9]{0,15}"';
    const field = `(?:"(?:entry|root|delegate|certificateRoot)"\\s*:\\s*"[0-9a-f:]{1,80}"|"oids"\\s*:\\s*\\[\\s*(?:${id}(?:\\s*,\\s*${id})*)?\\s*\\]|"oid"\\s*:\\s*${id}|"(?:revision|certificateHeight)"\\s*:\\s*${number}|"message_b64"\\s*:\\s*"[A-Za-z0-9+/]*={0,2}")`;
    if (!new RegExp(`^\\s*\\{\\s*${Array(9).fill(field).join("\\s*,\\s*")}\\s*\\}\\s*$`).test(raw)) throw Error("invalid body");
    const keys = new Set<string>();
    for (const match of raw.matchAll(/"([^"\\]*)"\s*:/g)) {
      if (keys.has(match[1]!)) throw Error("duplicate field"); keys.add(match[1]!);
    }
    return JSON.parse(raw) as unknown;
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid certificate request" }) });
}
