import { createServer } from "node:net";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { nodeFixture } from "./core-fixture.ts";
import { refundPolicy } from "./application-fixture.ts";
import type { RuntimeConfig } from "../../src/runtime/config.ts";

async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("missing port");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
export async function runtimeFixture(t: TestContext) {
  const f = await nodeFixture(t), operator = randomUUID(), subs = randomUUID();
  const journalDirectory = join(f.root, "journal"); mkdirSync(journalDirectory);
  const config: RuntimeConfig = { version: 1, network: "regtest", database: join(f.root, "store.db"), journalDirectory,
    listen: { buyer: await port(), operator: await port(), subs: await port() },
    core: { ...f.config, wallet: "merchant" }, credentials: { operator: join(f.root, "operator"), subs: join(f.root, "subs") },
    riskBudgetSats: 1_000_000, refundPolicy, merchantDestinations: [], pollMilliseconds: 100 };
  writeFileSync(config.credentials.operator, operator, { mode: 0o600 }); writeFileSync(config.credentials.subs, subs, { mode: 0o600 });
  const api = async (url: string, path: string, token?: string, value?: unknown) => {
    const response = await fetch(url + path, { method: value === undefined ? "GET" : "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {}, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, value: await response.json() as { [key: string]: unknown } };
  };
  return { ...f, config, operator, subs, api };
}
export async function until(work: () => Promise<void>) {
  const end = Date.now() + 10_000;
  for (;;) { try { await work(); return; } catch (e) { if (Date.now() > end) throw e; await new Promise(resolve => setTimeout(resolve, 25)); } }
}
