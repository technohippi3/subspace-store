import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import type { Fixture } from "./application-fixture.ts";

export const credential = "mock-bound-entry-operator-token".padEnd(48, "x");
export async function faultProxy(t: TestContext, target: string) {
  const control = { before: false, after: false, creates: 0, upstreamCreates: 0, lookups: 0, beforePath: "", afterPath: "", closes: 0, arms: 0,
    beforeClose: null as (() => void) | null };
  const server = createServer(async (request, response) => {
    try {
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
      const create = request.url === "/operator/issuance-entries";
      if (request.url?.endsWith("/close")) control.closes++;
      if (request.url?.endsWith("/arm")) control.arms++;
      if (create) control.creates++;
      if (request.url?.endsWith("/lookup")) control.lookups++;
      if (create && control.before) { control.before = false; response.destroy(); return; }
      if (control.beforePath && request.url === control.beforePath) { control.beforePath = ""; response.destroy(); return; }
      if (create) control.upstreamCreates++;
      if (request.url?.endsWith("/close")) control.beforeClose?.();
      const upstream = await fetch(target + request.url, { method: request.method!,
        headers: { Authorization: request.headers.authorization ?? "" },
        ...(request.method === "POST" ? { body: Buffer.concat(parts).toString() } : {}) });
      const body = await upstream.text();
      if (create && control.after) { control.after = false; response.destroy(); return; }
      if (control.afterPath && request.url === control.afterPath) { control.afterPath = ""; response.destroy(); return; }
      response.writeHead(upstream.status, { "Content-Type": "application/json" }); response.end(body);
    } catch { response.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === "string") throw Error("proxy unavailable");
  return { url: `http://127.0.0.1:${address.port}`, control };
}
export function controller(f: Fixture, url: string) {
  const token = join(f.root, "mock-operator-token"); writeFileSync(token, credential, { mode: 0o600 });
  return async (mode: string) => {
    const args = ["test/production/bound-controller-client.py", mode, url, token,
      f.config.database, f.config.journalDirectory, f.root];
    try {
      const result = await promisify(execFile)("python3", args);
      return { code: 0, ...JSON.parse(result.stdout) as { state: string; key: string; attempted: number; sends: number; error: string | null;
        children: string[]; child_states: Record<string, string>; rollbacks: number; result: string | null } };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 9)
        return { code: 9, state: "", key: "", attempted: 0, sends: 0, error: null,
          children: [] as string[], child_states: {} as Record<string, string>, rollbacks: 0, result: null };
      throw error;
    }
  };
}
