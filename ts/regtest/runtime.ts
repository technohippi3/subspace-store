import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { BitcoinRpc, RpcConfig } from "../src/bitcoin/rpc.ts";
import { refundPolicy } from "../test/production/application-fixture.ts";
import { object } from "../src/bitcoin/validation.ts";

const run = <A, E>(value: Effect.Effect<A, E>) => Effect.runPromise(value);
export async function runtimeQualification(repository: string, root: string, core: RpcConfig, buyer: BitcoinRpc,
  node: BitcoinRpc, minerAddress: string, freePort: () => Promise<number>) {
  const directory = join(root, "runtime"), journalDirectory = join(directory, "journal"); mkdirSync(journalDirectory, { recursive: true });
  const operator = randomUUID(), subs = randomUUID(), file = join(directory, "config.json");
  const credentials = { operator: join(directory, "operator-token"), subs: join(directory, "subs-token") };
  writeFileSync(credentials.operator, operator, { mode: 0o600 }); writeFileSync(credentials.subs, subs, { mode: 0o600 });
  const listen = { buyer: await freePort(), operator: await freePort(), subs: await freePort() };
  writeFileSync(file, JSON.stringify({ version: 1, network: "regtest", database: join(directory, "store.db"), journalDirectory,
    listen, core: { url: core.url, cookiePath: core.cookiePath, wallet: "merchant" }, credentials,
    riskBudgetSats: 100_000, refundPolicy, merchantDestinations: [], pollMilliseconds: 100 }));
  let child: ChildProcess | undefined, output = "";
  const api = async (role: "buyer" | "operator", path: string, value?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${listen[role]}${path}`, { method: value === undefined ? "GET" : "POST",
      headers: role === "operator" ? { Authorization: `Bearer ${operator}` } : {},
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    assert(response.ok, `${role} ${path} returned ${response.status}`); return object(await response.json());
  };
  async function until(work: () => Promise<void>) {
    const deadline = Date.now() + 20_000;
    for (;;) { try { await work(); return; } catch (e) { if (Date.now() > deadline) throw e; await new Promise(resolve => setTimeout(resolve, 50)); } }
  }
  async function start() {
    output = "";
    child = spawn(process.execPath, [join(repository, "ts/src/main.ts"), file], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout!.on("data", data => { output += String(data); });
    await until(async () => { assert.equal(child!.exitCode, null); assert.match(output, /"event":"ready"/); });
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, "exit"); child.kill("SIGTERM"); assert.equal((await ended)[0], 0);
  }
  try {
    await start();
    const status = await api("operator", "/operator/status"), chain = object(status.chain), info = object(await run(node.call("getblockchaininfo")));
    assert.equal(status.paused, true); assert.equal(chain.network, "regtest"); assert.equal(chain.best_block_hash, info.bestblockhash);
    await api("operator", "/operator/listings", { handle: "runtime@space", price_sats: 1000 });
    await api("operator", "/operator/pause", { paused: false });
    const request = await api("buyer", "/requests", { handle: "runtime@space", script_pubkey: "5120" + "1".padStart(64, "0") });
    const quote = await api("buyer", String(request.order_link) + "/quote", {}); assert.equal(quote.acknowledged, true);
    await run(buyer.call("sendtoaddress", quote.address, "0.00001000"));
    await run(node.call("generatetoaddress", 3, minerAddress));
    await until(async () => { assert.equal((await api("operator", "/operator/orders/o1")).status, "converted"); });
    await stop(); await start();
    assert.equal((await api("buyer", String(request.order_link))).status, "converted");
    assert.equal(object((await api("operator", "/operator/status")).chain).best_block_hash,
      object(await run(node.call("getblockchaininfo"))).bestblockhash);
  } finally { await stop(); }
}
