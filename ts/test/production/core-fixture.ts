import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";

export interface Call { id: string; method: string; params: unknown[]; path: string }
export interface Reply { result?: unknown; code?: number; status?: number; raw?: string; id?: string; location?: string }
export async function rpcFixture(t: TestContext, handler: (call: Call) => Reply | Promise<Reply>) {
  const root = mkdtempSync(join(tmpdir(), "core-rpc-")), cookiePath = join(root, "cookie");
  writeFileSync(cookiePath, `__cookie__:${randomUUID()}`, { mode: 0o600 });
  const calls: Call[] = [], authentication: boolean[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const correct = "Basic " + Buffer.from(readFileSync(cookiePath, "utf8").trim()).toString("base64");
        const authorized = request.headers.authorization === correct;
        authentication.push(authorized);
        if (!authorized) { response.writeHead(401); response.end(); return; }
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Omit<Call, "path">;
        const call = { ...input, path: request.url ?? "" }; calls.push(call);
        const result = await handler(call);
        if (response.destroyed) return;
        response.writeHead(result.status ?? 200, result.location ? { Location: result.location } : {});
        response.end(result.raw ?? JSON.stringify({ jsonrpc: "2.0", id: result.id ?? input.id,
          ...(result.code === undefined ? { result: result.result ?? null } :
            { error: { code: result.code, message: "simulated Core failure" } }) }));
      } catch { end(response); }
    })();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections(); await closed; rmSync(root, { recursive: true, force: true });
  });
  const address = server.address(); if (!address || typeof address === "string") throw Error("missing test listener");
  return { root, calls, authentication, config: { url: `http://127.0.0.1:${address.port}/`, cookiePath } };
}
function end(response: ServerResponse): void { if (!response.destroyed) { response.writeHead(500); response.end(); } }

export const hash = "a".repeat(64), block = "b".repeat(64), txid = "c".repeat(64);
export const script = "5120" + "2".padStart(64, "0");
export const recorded = { address: "mock-recorded-address", script };
export function nodeFixture(t: TestContext) {
  const state = { version: 310200, chain: "regtest", ibd: false, scanning: false, loaded: true,
    height: 100, hash, owned: true, walletName: "merchant", walletTip: hash,
    txids: [txid], conf: 2, mempool: true, mempoolCode: -5,
    outputs: [{ n: 0, value: 0.000006, scriptPubKey: { hex: script } },
      { n: 1, value: 0.000004, scriptPubKey: { hex: script } }],
    mutate: null as ((call: Call) => Reply | undefined) | null };
  return rpcFixture(t, call => {
    const changed = state.mutate?.(call); if (changed) return changed;
    switch (call.method) {
      case "getblockhash": return { result: call.params[0] === 0 ? (state.chain === "main" ? "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f" : "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206") : block };
      case "listdescriptors": return { result: { descriptors: [{desc:"tr(mock-public-expression/*)#fixture",active:true,internal:false}] } };
      case "getnetworkinfo": return { result: { version: state.version } };
      case "getmempoolinfo": return { result: { loaded: state.loaded } };
      case "getblockchaininfo": return { result: { chain: state.chain, blocks: state.height,
        headers: state.height, initialblockdownload: state.ibd, bestblockhash: state.hash } };
      case "getwalletinfo": return { result: { walletname: state.walletName, scanning: state.scanning,
        descriptors: true, lastprocessedblock: { height: state.height, hash: state.walletTip } } };
      case "getaddressinfo": return { result: { address: call.params[0], scriptPubKey: script, ismine: state.owned } };
      case "getnewaddress": return { result: "mock-new-address" };
      case "listsinceblock": return { result: { lastblock: state.hash,
        transactions: state.txids.map(txid => ({ address: recorded.address, txid })) } };
      case "gettransaction": return { result: { txid: call.params[0], confirmations: state.conf, blockhash: block,
        decoded: { txid: call.params[0], vout: state.outputs } } };
      case "getblockheader": return { result: { hash: block, height: state.height - state.conf + 1, confirmations: state.conf } };
      case "getmempoolentry": return state.mempool ? { result: { time: 1, height: state.height } } : { code: state.mempoolCode };
      default: return { code: -32601 };
    }
  }).then(f => ({ ...f, state, coreConfig: { ...f.config, wallet: "merchant", network: "regtest" as const } }));
}
