import { refuse } from "./errors.ts";
import type { ControllerJournal } from "./journal.ts";
import { strictJson } from "./json.ts";

export const protocolPrefix = "SSCJ3 ";
export function protocolRecord(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid mandatory controller protocol", "invalid");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "kind,requires,seq,version" || row.kind !== "controller_protocol" || row.version !== 3 ||
      !Number.isSafeInteger(row.seq) || (row.seq as number) < 1 || !Array.isArray(row.requires) ||
      row.requires.length !== 1 || row.requires[0] !== "preparation_abort_v1") refuse("unsupported mandatory controller journal protocol", "invalid");
}
export function frameRecord(value: Record<string, unknown>): string {
  if (value.kind === "controller_protocol") {
    protocolRecord(value);
    return protocolPrefix + JSON.stringify({ kind: value.kind, requires: value.requires, seq: value.seq, version: value.version });
  }
  return JSON.stringify(value);
}
export function decodeRecord(raw: string): unknown {
  const framed = raw.startsWith(protocolPrefix), value = strictJson(framed ? raw.slice(protocolPrefix.length) : raw);
  if (framed || value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind === "controller_protocol") {
    if (!framed) refuse("mandatory controller protocol lacks framing", "invalid");
    protocolRecord(value);
  }
  return value;
}
export function requireAbortProtocol(journal: ControllerJournal): void {
  if (!journal.entries().some(row => row.kind === "controller_protocol")) journal.appendEvent("controller_protocol", { version: 3, requires: ["preparation_abort_v1"] });
  if (!journal.entries().some(row => row.kind === "controller_protocol")) refuse("mandatory controller protocol not acknowledged", "unavailable");
}
export function upgradeAbortHistory(journal: ControllerJournal): void {
  const rows = journal.entries();
  if (rows.some(row => row.kind === "preparation_abort") && !rows.some(row => row.kind === "controller_protocol")) requireAbortProtocol(journal);
}
