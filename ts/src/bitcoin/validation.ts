import { ApplicationError, MAX_MONEY } from "../application/records.ts";

export function invalid(message: string): never {
  throw new ApplicationError({ code: "unavailable", message });
}
export function object(value: unknown): { [key: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("invalid Core response");
  return value as { [key: string]: unknown };
}
export function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid("invalid Core integer");
  return value as number;
}
export function hex(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid("invalid Core hash");
  return value;
}
/** Exact BTC decimal/exponent -> whole sats; no floating-point money arithmetic. */
export function amount(value: unknown): number {
  if (typeof value !== "string" || value.length > 64) invalid("invalid Core amount");
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(value);
  if (!match) invalid("invalid Core amount");
  const fraction = match[2] ?? "", power = 8 - fraction.length + Number(match[3] ?? 0);
  if (!Number.isSafeInteger(power) || Math.abs(power) > 64) invalid("invalid Core amount");
  let number = BigInt(match[1]! + fraction);
  if (power >= 0) number *= 10n ** BigInt(power);
  else {
    const divisor = 10n ** BigInt(-power);
    if (number % divisor !== 0n) invalid("sub-satoshi Core amount");
    number /= divisor;
  }
  if (number < 0n || number > BigInt(MAX_MONEY)) invalid("Core amount exceeds money supply");
  return Number(number);
}
