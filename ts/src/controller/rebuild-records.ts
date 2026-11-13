import { createHash } from "node:crypto";
import { canonicalHandle, validP2tr } from "../recipient.ts";
import { refuse } from "./errors.ts";
import { hash, type Batch } from "./records.ts";
import type { NativeHandle, OrderBinding } from "./ports.ts";
import { ORDER_STATUSES, type OrderStatus } from "../order.ts";

export function orderBinding(value: unknown, b: Batch, oid: string): OrderBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid controller order binding", "invalid");
  const v = value as Record<string, unknown>;
  if (!b.members.includes(oid) || v.oid !== oid || !canonicalHandle(v.name) || !v.name.endsWith(b.space) || !validP2tr(v.recipient_spk) ||
      !ORDER_STATUSES.includes(v.status as OrderStatus))
    refuse("controller order binding differs from batch", "invalid");
  return { oid, name: v.name, recipient_spk: v.recipient_spk, status: v.status as OrderStatus };
}
export function nativeHandle(value: NativeHandle, expected: OrderBinding): NativeHandle {
  if (!value || typeof value !== "object" || value.script_pubkey !== expected.recipient_spk ||
      value.commitment_root !== null && !hash(value.commitment_root) || typeof value.parked !== "boolean")
    refuse("native rebuild root or recipient differs; rollback withheld");
  return value;
}
/** Python json.dumps(sorted((name, recipient_spk, oid), ...)) for ASCII bindings. */
export function successorDigest(bindings: readonly OrderBinding[]): string {
  const rows = bindings.map(b => [b.name, b.recipient_spk, b.oid]).sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1; return 0;
  });
  const text = "[" + rows.map(row => "[" + row.map(value => JSON.stringify(value)).join(", ") + "]").join(", ") + "]";
  return createHash("sha256").update(text).digest("hex");
}
export function failedSet(b: Batch, value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some(id => !b.members.includes(id)) || new Set(value).size !== value.length)
    refuse("invalid failed controller members", "invalid");
  return [...value].sort();
}
