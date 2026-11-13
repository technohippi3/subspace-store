/** Pinned-shaped HTTP recording native; no wallet, prover or genuine commitment. */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import { Effect } from "effect";
import { ControllerError } from "../../src/controller/errors.ts";
import type { PreparationNative } from "../../src/controller/preparation-ports.ts";

export interface PublicHandle {
  name: string; script_pubkey: string; status: "staged" | "committed"; commitment_root: string | null;
  commitment_idx: number | null; publish_status: string | null; parked: boolean;
}
interface Space { chain: string | null; root: string | null; txid: string | null; pending: boolean; idx: number | null; handles: PublicHandle[] }
interface State { spaces: Record<string, Space>; syncs: number; parks: number; commits: number; queued: { path: string; body: unknown }[] }
export function stagedHandle(name: string, script: string, parked = false): PublicHandle {
  return { name, script_pubkey: script, status: "staged", commitment_root: null, commitment_idx: null, publish_status: null, parked };
}
export function readNative(root: string): State { return JSON.parse(readFileSync(join(root, "preparation-native.json"), "utf8")) as State; }
export function saveNative(root: string, value: State): void {
  const file = join(root, "preparation-native.json"); writeFileSync(file, JSON.stringify(value));
  const fd = openSync(file, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export async function nativeServer(t: TestContext, root: string, pendingUrl: string, credential: string) {
  saveNative(root, { spaces: { "@space": { chain: null, root: null, txid: null, pending: false, idx: null, handles: [] } }, syncs: 0, parks: 0, commits: 0, queued: [] });
  const control = { loseBefore: "", loseAfter: "", delayed: "", transform: undefined as ((path: string, value: unknown) => unknown) | undefined,
    after: undefined as ((path: string) => void) | undefined };
  const apply = async (path: string, body: unknown): Promise<unknown> => {
    const state = readNative(root), parsed = new URL(path, "http://127.0.0.1"), spaceName = decodeURIComponent(parsed.pathname.split("/")[2] ?? "");
    const space = state.spaces[spaceName];
    if (parsed.pathname === "/registry/sync") {
      state.syncs++; let pulled = 0, staged = 0;
      for (const [name, target] of Object.entries(state.spaces)) {
        const response = await fetch(pendingUrl + "/pending?space=" + encodeURIComponent(name), { headers: { Authorization: `Bearer ${credential}` } });
        const pending = await response.json() as { handles: { handle: string; script_pubkey: string }[] };
        for (const order of pending.handles) { pulled++; const label = order.handle.split("@")[0]!;
          if (!target.handles.some(h => h.name === label)) { target.handles.push(stagedHandle(label, order.script_pubkey)); staged++; }
        }
      }
      saveNative(root, state); return { success: true, pulled, staged, errors: [] };
    }
    if (!space) throw Error("unloaded recording space");
    if (parsed.pathname.endsWith("/pipeline")) return { has_pending: space.pending, staged_count: space.handles.filter(h => h.commitment_root === null && !h.parked).length,
      commitment_idx: space.idx, root: space.root, txid: space.txid, steps: Object.fromEntries(["local", "proving", "broadcast", "confirmed", "finalized", "published"]
        .map(step => [step, space.root === null ? "pending" : step === "local" || !space.pending ? "complete" : "pending"])) };
    if (parsed.pathname.endsWith("/handles")) {
      const filter = parsed.searchParams.get("filter"), rows = space.handles.filter(h => filter === "staged" ? h.commitment_root === null : h.commitment_root !== null)
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), page = Number(parsed.searchParams.get("page"));
      return { handles: rows.slice((page - 1) * 100, page * 100), total: rows.length, page, per_page: 100, total_pages: Math.ceil(rows.length / 100) };
    }
    if (parsed.pathname.includes("/handles/")) return space.handles.find(h => h.name === decodeURIComponent(parsed.pathname.split("/").at(-1)!)) ?? null;
    if (parsed.pathname.endsWith("/park")) {
      const value = body as { handles: string[]; parked: boolean }; state.parks++; let updated = 0;
      for (const handle of space.handles) if (handle.commitment_root === null && value.handles.includes(handle.name)) { handle.parked = value.parked; updated++; }
      saveNative(root, state); return { updated };
    }
    if (parsed.pathname.endsWith("/commit")) {
      state.commits++; const previous = space.root, commitmentRoot = createHash("sha256").update(`recording-local-root-${state.commits}`).digest("hex");
      let handles = 0; space.idx = space.idx === null ? 0 : space.idx + 1;
      for (const handle of space.handles) if (handle.commitment_root === null && !handle.parked) {
        handle.commitment_root = commitmentRoot; handle.commitment_idx = space.idx; handle.status = "committed"; handles++;
      }
      space.root = commitmentRoot; space.txid = null; space.pending = true; saveNative(root, state);
      return { space: spaceName, prev_root: previous, root: commitmentRoot, handles_committed: handles, is_initial: previous === null };
    }
    throw Error("unexpected recording path");
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as unknown : null, path = request.url!;
      if (control.loseBefore === path) { control.loseBefore = ""; response.destroy(); return; }
      if (control.delayed === path) {
        control.delayed = ""; const state = readNative(root); state.queued.push({ path, body }); saveNative(root, state); response.destroy(); return;
      }
      let result = await apply(path, body);
      control.after?.(path);
      if (control.loseAfter === path) { control.loseAfter = ""; response.destroy(); return; }
      if (control.transform) result = control.transform(path, result);
      if (result === null && path.includes("/handles/")) { response.writeHead(404); response.end("{}"); return; }
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
    } catch { response.writeHead(503); response.end("{}"); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === "string") throw Error("recording listener missing");
  return { url: `http://127.0.0.1:${address.port}`, control, applyQueued: async () => {
    const queued = readNative(root).queued; const state = readNative(root); state.queued = []; saveNative(root, state);
    for (const effect of queued) await apply(effect.path, effect.body);
  } };
}
export function nativeClient(origin: string): PreparationNative {
  const request = (path: string, body?: unknown, absent = false) => Effect.tryPromise({ try: async () => {
    const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });
    if (absent && response.status === 404) return null;
    if (!response.ok) throw Error("recording native response failed"); return await response.json() as unknown;
  }, catch: () => new ControllerError({ code: "unavailable", message: "recording native response unavailable" }) });
  return { pipeline: space => request(`/spaces/${space}/pipeline`), page: (space, page, filter) => request(`/spaces/${space}/handles?filter=${filter}&page=${page}&per_page=100`),
    handle: (space, label) => request(`/spaces/${space}/handles/${label}`, undefined, true), sync: () => request("/registry/sync", {}),
    park: (space, labels, parked) => request(`/spaces/${space}/park`, { handles: labels, parked }), commit: space => request(`/spaces/${space}/commit`, {}) };
}
