import { RecoveryCommand, JOURNAL_PAGE_BYTES, JOURNAL_PAGE_ENTRIES } from "./ssh-journal.ts";
import { ENVELOPE_MAX_BYTES, ENVELOPE_MAX_HEAD, ENVELOPE_PREFIX_MAX_BYTES,
  inspectEnvelopePrefix, readJournalPayload, type EnvelopeRecord } from "./journal-envelope.ts";

interface Stored { readonly record: EnvelopeRecord; readonly remoteSha256: string }
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const head = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= ENVELOPE_MAX_HEAD;
const equal = (a: Stored, b: Stored) => a.remoteSha256 === b.remoteSha256 && Buffer.from(a.record.bytes).equals(b.record.bytes);
function shape(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
    throw Error("invalid SSH journal response fields");
}

/** Dormant structural byte boundary, not the selected Entry-only Journal.
 * Caller-held exclusive ownership and protected transport/key custody are
 * required throughout use. No domain, activation or external-effect permission. */
export class EnvelopeSshJournal {
  readonly command: RecoveryCommand;
  private saved: readonly Stored[] = [];
  constructor(command: RecoveryCommand) { this.command = command; }

  private scan(): readonly Stored[] {
    const rows: Stored[] = []; let fixedHead: number | undefined, total = 0;
    while (true) {
      const after = rows.length;
      const page = this.command.request<unknown>({ op: "journal-read", stream: "store", after, limit: JOURNAL_PAGE_ENTRIES });
      shape(page, "entries,head,ok");
      if (page.ok !== true || !head(page.head) || page.head < after || fixedHead !== undefined && page.head !== fixedHead ||
          !Array.isArray(page.entries) || page.entries.length > JOURNAL_PAGE_ENTRIES) throw Error("SSH journal prefix invalid");
      fixedHead = page.head; let pageBytes = 0;
      for (const item of page.entries) {
        shape(item, "data,remoteSha256,sequence,sha256");
        if (item.sequence !== rows.length + 1 || rows.length >= fixedHead || !hex(item.sha256) || !hex(item.remoteSha256) ||
            typeof item.data !== "string" || item.data.length > 4 * Math.ceil(ENVELOPE_MAX_BYTES / 3))
          throw Error("invalid SSH journal record");
        const raw = Buffer.from(item.data, "base64"); pageBytes += raw.length; total += raw.length;
        if (raw.toString("base64") !== item.data || !raw.length || raw.length > ENVELOPE_MAX_BYTES ||
            pageBytes > JOURNAL_PAGE_BYTES || total > ENVELOPE_PREFIX_MAX_BYTES) throw Error("SSH journal byte bounds exceeded");
        const record = readJournalPayload(raw);
        if (record.recordDigest !== item.sha256 || record.entry.seq !== item.sequence) throw Error("SSH journal payload digest or sequence mismatch");
        rows.push(Object.freeze({ record, remoteSha256: item.remoteSha256 }));
      }
      if (rows.length === fixedHead) break;
      if (!page.entries.length) throw Error("incomplete SSH journal page");
    }
    inspectEnvelopePrefix((function* () { for (const row of rows) yield row.record.bytes; })());
    const live = this.command.request<unknown>({ op: "journal-head", stream: "store" });
    shape(live, "ok,remoteSha256,sequence,sha256");
    const last = rows.at(-1);
    if (live.ok !== true || live.sequence !== rows.length || live.sha256 !== (last?.record.recordDigest ?? null) ||
        live.remoteSha256 !== (last?.remoteSha256 ?? null)) throw Error("SSH journal head changed");
    return Object.freeze(rows);
  }
  private retained(next: readonly Stored[]): void {
    if (next.length < this.saved.length || this.saved.some((value, index) => !equal(value, next[index]!)))
      throw Error("retained SSH journal bytes or receipt changed or disappeared");
  }
  read(): readonly EnvelopeRecord[] {
    const next = this.scan(); this.retained(next); this.saved = next;
    return Object.freeze(next.map(value => value.record));
  }
  /** Exact P, without a physical-file LF. Every retry rechecks live history;
   * a thrown error remains an unknown publication outcome, never absence. */
  append(payload: Uint8Array): undefined {
    const record = readJournalPayload(payload), before = this.scan(); this.retained(before);
    const retry = record.entry.seq <= before.length;
    if (retry) {
      if (!Buffer.from(before[record.entry.seq - 1]!.record.bytes).equals(record.bytes)) throw Error("SSH journal retry bytes differ");
    } else {
      if (record.entry.version !== 2) throw Error("new legacy SSH journal writes are unsupported");
      inspectEnvelopePrefix((function* () { for (const row of before) yield row.record.bytes; yield record.bytes; })());
    }
    const ack = this.command.request<unknown>({ op: "journal-append", stream: "store", sequence: record.entry.seq,
      sha256: record.recordDigest, data: Buffer.from(record.bytes).toString("base64") });
    shape(ack, "ok,remoteSha256,sequence,sha256");
    if (ack.ok !== true || ack.sequence !== record.entry.seq || ack.sha256 !== record.recordDigest || !hex(ack.remoteSha256))
      throw Error("SSH journal acknowledgment invalid");
    const next = this.scan(); this.retained(next);
    const actual = next[record.entry.seq - 1];
    if (next.length !== before.length + (retry ? 0 : 1) || before.some((value, index) => !equal(value, next[index]!)) ||
        !actual || !Buffer.from(actual.record.bytes).equals(record.bytes) || actual.remoteSha256 !== ack.remoteSha256)
      throw Error("SSH journal publication readback mismatch");
    this.saved = next;
  }
}
