import { existsSync, closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { checked, refuse } from "../../src/controller/errors.ts";
import { kernel } from "./controller-port-fixture.ts";
import type { NativeHandle, ReleasePorts } from "../../src/controller/ports.ts";
import type { Batch } from "../../src/controller/records.ts";
import { validP2tr } from "../../src/recipient.ts";
import { HttpRegistry } from "../../src/controller/registry-client.ts";
import { credential } from "./entry-http-fixture.ts";
import type { SalesStore } from "../../src/application/store.ts";
import { payment, setup, type Fixture } from "./application-fixture.ts";

export function scripts(count = 2): string[] {
  const values: string[] = [];
  for (let n = 1; values.length < count; n++) {
    const script = "5120" + n.toString(16).padStart(64, "0"); if (validP2tr(script)) values.push(script);
  }
  return values;
}
export function paidMembers(store: SalesStore, f: Fixture, count = 2) {
  return Effect.gen(function* () {
    yield* setup(store); const recipients = scripts(count), tokens: string[] = [];
    for (let i = 0; i < count; i++) {
      const request = yield* store.request({ handle: `n${i}@space`, script_pubkey: recipients[i]! });
      yield* store.quote(request.token); tokens.push(request.token);
    }
    f.node.outputs = Array.from({ length: count }, (_, i) => payment(i + 1)); yield* store.observe(); return tokens;
  });
}
type MutableHandle = { -readonly [K in keyof NativeHandle]: NativeHandle[K] };
interface NativeState { height: number; rollbacks: number; parks: number; chain: string | null; head: string | null; txid: string | null; pending: boolean; handles: Record<string, MutableHandle> }
export class RecordingNative implements ReleasePorts {
  readonly file: string;
  afterRollback: (() => void) | undefined;
  afterPark: (() => void) | undefined;
  constructor(root: string, count = 2) {
    this.file = join(root, "rebuild-native.json");
    if (!existsSync(this.file)) this.save({ height: 10, rollbacks: 0, parks: 0, chain: null, head: "a".repeat(64), txid: null, pending: true, handles: Object.fromEntries(scripts(count).map((script, i) =>
      [`n${i}`, { script_pubkey: script, commitment_root: "a".repeat(64), parked: false }])) });
  }
  state(): NativeState { return JSON.parse(readFileSync(this.file, "utf8")) as NativeState; }
  save(value: NativeState): void {
    writeFileSync(this.file, JSON.stringify(value)); const fd = openSync(this.file, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  handle(space: string, label: string) {
    return checked("read recording native handle", () => {
      if (space !== "@space") refuse("unexpected fake space"); const value = this.state().handles[label];
      if (!value) refuse("unknown fake handle"); return value;
    });
  }
  rollback(space: string) {
    return checked("record fake rollback", () => {
      if (space !== "@space") refuse("unexpected fake space"); const value = this.state(); value.rollbacks++;
      for (const handle of Object.values(value.handles)) handle.commitment_root = null;
      this.save(value); this.afterRollback?.();
    });
  }
  park(space: string, labels: readonly string[]) {
    return checked("record fake parking", () => {
      if (space !== "@space") refuse("unexpected fake space"); const value = this.state(); value.parks++;
      for (const label of labels) value.handles[label]!.parked = true; this.save(value); this.afterPark?.();
    });
  }
}
export function rebuildKernel(root: string, origin: string, count = 2) {
  const k = kernel(root, origin), native = new RecordingNative(root, count);
  const unavailable = () => checked("forbid preparation effect in read-only fixture", () => refuse("read-only preparation fixture", "unavailable"));
  return { ...k, native, ports: { ...k.ports, height: () => Effect.succeed(native.state().height), release: native,
    preparation: { registry: new HttpRegistry(origin, Effect.succeed(credential)), chainRoot: () => Effect.succeed(native.state().chain), native: {
      pipeline: () => Effect.sync(() => { const state = native.state(); return { root: state.head, txid: state.txid, has_pending: state.pending,
        commitment_idx: state.head === null ? null : 0, staged_count: Object.values(state.handles).filter(h => h.commitment_root === null && !h.parked).length,
        steps: Object.fromEntries(["local", "proving", "broadcast", "confirmed", "finalized", "published"].map(step => [step, state.head === null ? "pending" : "complete"])) }; }),
      handle: (_space: string, label: string) => Effect.sync(() => { const handle = native.state().handles[label]; return handle ? {
        ...handle, name: label, status: handle.commitment_root === null ? "staged" : "committed", commitment_idx: handle.commitment_root === null ? null : 0, publish_status: null } : null; }),
      page: unavailable, sync: unavailable, park: unavailable, commit: unavailable } } } };
}
export function batches(database: string): Batch[] {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare("select * from batches order by rowid").all().map(row => ({ ...row, members: JSON.parse(String(row.members)) } as unknown as Batch)); }
  finally { db.close(); }
}
export function recordedSends(root: string): number {
  const file = join(root, "rebuild-sends.jsonl"); return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0;
}
