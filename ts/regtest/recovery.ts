import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { BitcoinRpc } from "../src/bitcoin/rpc.ts";
import { object } from "../src/bitcoin/validation.ts";
import type { RuntimeConfig } from "../src/runtime/config.ts";

const run = <A,E>(value: Effect.Effect<A,E>) => Effect.runPromise(value);
/** Fresh journal-only database and the shipped commands. Core/wallet remain
 * live; this does not simulate a whole-host or controller/subs restore. */
export async function recoveryQualification(repository: string, file: string, buyer: BitcoinRpc,
  node: BitcoinRpc, miner: string, unpaidAddress: string) {
  const source = JSON.parse(readFileSync(file,"utf8")) as RuntimeConfig;
  const config = { ...source, database:join(source.database+".recovery.db") }, recoveryFile = file+".recovery.json";
  writeFileSync(recoveryFile,JSON.stringify(config),{mode:0o600});
  const {wallet:_wallet,...nodeConfig}=config.core, merchant=new BitcoinRpc({...nodeConfig,wallet:config.core.wallet});
  // Payment arrives while the store is stopped, so its journal has no
  // detection. Recovery must read Core before claiming current balances.
  await run(buyer.call("sendtoaddress",unpaidAddress,"0.00001000"));
  await run(node.call("generatetoaddress",3,miner));
  const tip=object(await run(node.call("getblockchaininfo"))), deadline=Date.now()+10000;
  for(;;){
    const wallet=object(await run(merchant.call("getwalletinfo")));
    if(object(wallet.lastprocessedblock).hash===tip.bestblockhash)break;
    assert(Date.now()<deadline,"payment wallet discovery did not reach Core tip");
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const walletState=async()=>({balances:await run(merchant.call("getbalances")),locks:await run(merchant.call("listlockunspent")),
    descriptors:await run(merchant.call("listdescriptors")),mempool:await run(node.call("getrawmempool"))});
  const before=await walletState();
  const command=async(mode?:string)=>{
    const result=await promisify(execFile)(process.execPath,[join(repository,"ts/src/main.ts"),...(mode?[mode]:[]),recoveryFile],{timeout:20000});
    assert.equal(result.stdout.includes('"event":"ready"'),false);return object(JSON.parse(result.stdout));
  };
  const restored=await command("restore");
  assert.equal(restored.acknowledged,true);assert.equal(restored.ready,false);assert.equal(restored.sales_paused,true);
  assert.equal(restored.chain,null);assert.equal(object(restored.orders).unknown_payment_history,1);
  assert.equal(object(restored.refunds).attempted,2);assert.equal(object(restored.refunds).settled,null);
  const observed=await command("recover");assert.equal(observed.phase,"observed");assert.equal(observed.ready,false);
  assert.equal(observed.acknowledged,true);assert.equal(object(observed.chain).hash,tip.bestblockhash);
  assert.equal(object(observed.orders).unknown_payment_history,0);assert.equal(object(observed.refunds).settled,2);
  assert.deepEqual((await command("recover")).chain,observed.chain);
  await assert.rejects(command());
  const db=new DatabaseSync(config.database,{readOnly:true});
  try{
    assert.equal(db.prepare("select restored from store_meta where id=1").get()!.restored,1);
    const order=JSON.parse(db.prepare("select value from records where kind='sales_order' and key='o2'").get()!.value as string) as {status:string;paymentHistory:string};
    assert.equal(order.status,"converted");assert.equal(order.paymentHistory,"detected");
    assert.equal(JSON.parse(db.prepare("select value from records where kind='application_recovery'").get()!.value as string).required,true);
  }finally{db.close();}
  assert.deepEqual(await walletState(),before,"recovery changed wallet, descriptors, locks or mempool");
  const journal=JSON.parse(readFileSync(recoveryFile,"utf8")) as RuntimeConfig;
  assert.equal(journal.journalDirectory,source.journalDirectory);
}
