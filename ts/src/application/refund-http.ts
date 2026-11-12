import type { IncomingMessage } from "node:http";
import { Effect } from "effect";
import { ApplicationError } from "./records.ts";
import { body } from "./http.ts";

export const groupId = 'g-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
export function refundBody(request: IncomingMessage) {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request), field = '(?:"kind"\\s*:\\s*"(?:cancellation|excess)"|"cause"\\s*:\\s*"(?:buyer|merchant)")';
    if (!new RegExp(`^\\s*\\{\\s*${field}\\s*,\\s*${field}\\s*\\}\\s*$`).test(raw)) throw Error("invalid body");
    const value = JSON.parse(raw) as { kind?: "cancellation" | "excess"; cause?: "buyer" | "merchant" };
    if (!value.kind || !value.cause) throw Error("duplicate field");
    return value as Required<typeof value>;
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid refund preparation request" }) });
}
export function refundSendBody(request: IncomingMessage, gid: string) {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request), field = `(?:"txid"\\s*:\\s*"[0-9a-f]{64}"|"confirm"\\s*:\\s*"${groupId}")`;
    if (!new RegExp(`^\\s*\\{\\s*${field}\\s*,\\s*${field}\\s*\\}\\s*$`).test(raw)) throw Error("invalid body");
    const value = JSON.parse(raw) as { txid?: string; confirm?: string };
    if (typeof value.txid !== "string" || value.confirm !== gid) throw Error("confirmation differs");
    return value.txid;
  }, catch: () => new ApplicationError({ code: "invalid", message: "refund requires exact transaction and group confirmation" }) });
}
