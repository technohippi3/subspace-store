import { spawn } from "node:child_process";
import { readFileSync, openSync, closeSync, fsyncSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { ApplicationError, checked } from "../application/records.ts";
import { fields, proofHash, type ControllerReceipt, type RecoveryInventory } from "../application/reconciliation-records.ts";
import type { RecoveryController } from "../application/reconciliation.ts";
import { BitcoinRpc } from "../bitcoin/rpc.ts";
import { object, integer, hex } from "../bitcoin/validation.ts";
import type { RuntimeConfig } from "./config.ts";

const unavailable=()=>new ApplicationError({code:"unavailable",message:"controller recovery evidence unavailable or changed"});
interface Host { network: "mainnet" | "regtest"; controller:{journal_dir:string;journal_name?:string;operator_wallet:string};
  spaced:{url:string;cookie_file:string}; subs:{url:string;write_url?:string} }
function host(file:string,network:RuntimeConfig["network"]):Host{
  const raw=readFileSync(file);if(raw.length>65536)throw unavailable();
  const v=object(JSON.parse(raw.toString("utf8"))),c=object(v.controller),s=object(v.spaced),u=object(v.subs);
  for(const item of [c.journal_dir,c.operator_wallet,s.url,s.cookie_file,u.url])if(typeof item!=="string"||!item||item.length>4096)throw unavailable();
  if(c.journal_name!==undefined&&(typeof c.journal_name!=="string"||!/^[a-zA-Z0-9_-]{1,64}$/.test(c.journal_name)))throw unavailable();
  if(v.network!==(network==="main"?"mainnet":"regtest"))throw unavailable();
  return v as unknown as Host;
}
/** Spawn with cancellation and a bounded response; inventory contains neither
 * wallet credentials nor transaction bytes. Parent retains store ownership. */
function runController(file:string,config:RuntimeConfig,input:RecoveryInventory){
  return Effect.tryPromise({try:signal=>new Promise<unknown>((resolvePromise,reject)=>{
    const child=spawn("python3",["-m","runner.recover_store",file],{cwd:fileURLToPath(new URL("../../../",import.meta.url)),stdio:["pipe","pipe","pipe"],signal});
    let output="",size=0;const timer=setTimeout(()=>child.kill("SIGKILL"),300000);
    child.stdout.on("data",data=>{size+=data.length;if(size>4194304)child.kill("SIGKILL");else output+=String(data);});
    child.stderr.on("data",()=>{});child.once("error",reject);
    child.once("close",code=>{clearTimeout(timer);try{if(code!==0||size>4194304)throw unavailable();resolvePromise(JSON.parse(output));}catch{reject(unavailable());}});
    child.stdin.on("error",reject);child.stdin.end(JSON.stringify({inventory:input,network:config.network,database:config.database,journalDirectory:config.journalDirectory,core:config.core}));
  }),catch:unavailable});
}
function confirmController(h:Host,receipt:ControllerReceipt){
  return checked(()=>{
    const name=h.controller.journal_name??"runner",directory=resolve(h.controller.journal_dir);
    if(existsSync(join(directory,name+".down")))throw unavailable();
    const file=join(directory,name+".jsonl"),lines=readFileSync(file,"utf8").trim().split("\n");
    if(receipt.position!==lines.length||lines.some((line,index)=>(JSON.parse(line) as {seq?:unknown}).seq!==index+1))throw unavailable();
    const row=JSON.parse(lines[receipt.position-1]!) as {[key:string]:unknown};
    fields(row,"seq,kind,statement,proofHash");
    if(row.seq!==receipt.position||row.kind!=="store_reconciliation"||row.proofHash!==receipt.proofHash||proofHash(row.statement)!==receipt.proofHash)throw unavailable();
    const fd=openSync(file,"r"),dir=openSync(directory,"r");
    try{fsyncSync(fd);fsyncSync(dir);}finally{closeSync(fd);closeSync(dir);}
  });
}
function verify(config:RuntimeConfig,h:Host,receipt:ControllerReceipt){
  return Effect.tryPromise({try:async()=>{
    const s=receipt.statement,{wallet:_wallet,...c}=config.core,node=new BitcoinRpc(c),spaced=new BitcoinRpc({url:h.spaced.url,cookiePath:h.spaced.cookie_file});
    const rpc=(client:BitcoinRpc,method:string,...params:unknown[])=>Effect.runPromise(client.call(method,...params));
    const tip=object(await rpc(node,"getblockchaininfo"));if(tip.chain!==config.network||tip.bestblockhash!==s.tipHash||tip.blocks!==s.tipHeight)throw unavailable();
    const info=object(await rpc(spaced,"getserverinfo")),wallet=object(await rpc(spaced,"walletgetinfo",h.controller.operator_wallet));
    if(info.network!==(config.network==="main"?"mainnet":"regtest")||object(info.tip).hash!==s.tipHash||wallet.tip!==s.tipHeight)throw unavailable();
    const known=new Set<string>();let complete=false;
    for(let page=0;page<1000;page++){
      const rows=await rpc(spaced,"walletlisttransactions",h.controller.operator_wallet,100,page*100);
      if(!Array.isArray(rows))throw unavailable();for(const row of rows)known.add(hex(object(row).txid));
      if(rows.length<100){complete=true;break;}
    }
    if(!complete||s.entries.some(e=>e.walletTxid!==null&&!known.has(e.walletTxid)))throw unavailable();
    for(const row of s.entries)if(row.observation){
      const o=row.observation;let tx:ReturnType<typeof object>;
      if(o.minedHeight!==null){const block=await rpc(node,"getblockhash",o.minedHeight);tx=object(await rpc(node,"getrawtransaction",o.txid,true,block));
        const header=object(await rpc(node,"getblockheader",block));if(tx.blockhash!==block||header.hash!==block||integer(header.height)!==o.minedHeight||integer(header.confirmations)!==s.tipHeight-o.minedHeight+1)throw unavailable();
      }else{await rpc(node,"getmempoolentry",o.txid);tx=object(await rpc(node,"getrawtransaction",o.txid,true));if(tx.blockhash!==undefined)throw unavailable();}
      if(tx.txid!==o.txid||!Array.isArray(tx.vin)||!tx.vin.map(object).some(i=>`${hex(i.txid)}:${integer(i.vout)}`===row.delegate)||
        !Array.isArray(tx.vout)||!tx.vout.map(object).some(v=>{const script=object(v.scriptPubKey).hex;return typeof script==="string"&&script.startsWith("6a")&&script.includes(row.root);}))throw unavailable();
      const root=await rpc(spaced,"getcommitment",row.space,row.root);
      if(o.rootHeight===null?root!==null:root===null||object(root).state_root!==row.root||object(root).block_height!==o.rootHeight)throw unavailable();
    }
    for(const row of s.spaces){
      const chain=await rpc(spaced,"getcommitment",row.space);if((chain===null?null:object(chain).state_root)!==row.chainRoot)throw unavailable();
      const response=await fetch(h.subs.url.replace(/\/$/,"")+`/spaces/${row.space}/pipeline`,{redirect:"error",signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw unavailable();const pipeline=object(await response.json());
      if((pipeline.root??null)!==row.subsRoot||(pipeline.txid??null)!==row.subsTxid)throw unavailable();
    }
    if(object(await rpc(node,"getblockchaininfo")).bestblockhash!==s.tipHash||object(object(await rpc(spaced,"getserverinfo")).tip).hash!==s.tipHash)throw unavailable();
  },catch:unavailable});
}
export function controllerRecovery(config:RuntimeConfig,file:string):RecoveryController{
  const h=host(file,config.network);
  return {run:input=>runController(file,config,input),verify:receipt=>verify(config,h,receipt),confirm:receipt=>confirmController(h,receipt)};
}
