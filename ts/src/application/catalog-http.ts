import type { IncomingMessage } from "node:http";
import { Effect } from "effect";
import { ApplicationError } from "./records.ts";
import { body } from "./http.ts";

export function catalogBody(request: IncomingMessage) {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request);
    const field = '(?:"handle"\\s*:\\s*"[a-z0-9_-]+@[a-z0-9_-]+"|"price_sats"\\s*:\\s*[1-9][0-9]{0,15})';
    if (!new RegExp(`^\\s*\\{\\s*${field}\\s*,\\s*${field}\\s*\\}\\s*$`).test(raw)) throw Error("invalid body");
    const value = JSON.parse(raw) as { handle?: string; price_sats?: number };
    if (typeof value.handle !== "string" || !Number.isSafeInteger(value.price_sats)) throw Error("invalid fields");
    return value as { handle: string; price_sats: number };
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid listing request" }) });
}
export function pauseBody(request: IncomingMessage) {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request);
    if (!/^\s*\{\s*"paused"\s*:\s*(?:true|false)\s*\}\s*$/.test(raw)) throw Error("invalid body");
    return (JSON.parse(raw) as { paused: boolean }).paused;
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid pause request" }) });
}
