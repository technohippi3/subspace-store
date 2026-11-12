import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Effect} from 'effect';
import {sendingFixture,tipHash} from './refund-sending-fixture.ts';
import {use,setup,payment} from './application-fixture.ts';
import {serveOperator} from '../../src/application/operator-http.ts';
import {credential,faultProxy} from './entry-http-fixture.ts';
import {ApplicationError} from '../../src/application/records.ts';
export {Effect,assert};
export const run=effect=>Effect.runPromise(effect);
export const scoped=effect=>Effect.runPromise(Effect.scoped(effect));
export async function within(t,callback,count=2,price=10000){
 const f=sendingFixture(t);f.node.tip=210;
 const chain={tipHeight:210,tipHash,txid:'a'.repeat(64),delegate:'d'.repeat(64)+':0',root:'a'.repeat(64),roots:{['a'.repeat(64)]:null},anchorHeight:210,minedHeight:null,known:false,mempool:false,oids:Array.from({length:count},(_,i)=>'o'+(i+1)),conflictTxid:'f'.repeat(64),conflictHeight:290,conflictActive:false};
 const control={valid:true};f.adapters.chainStatus=Effect.sync(()=>({network:'regtest',best_block_hash:chain.tipHash,blocks:f.node.tip}));
 f.adapters.certificateChain=()=>Effect.succeed(true);
 f.adapters.supersessionChain=()=>Effect.succeed(control.valid);
 return use(f,store=>Effect.gen(function*(){
  yield*setup(store,20);const tokens=[];
  for(let i=1;i<=count;i++){
   if(price!==1000)yield*store.listName(`n${i-1}@space`,price);
   const script='5120'+String(i).padStart(64,'0');
   const link=yield*store.request({handle:`n${i-1}@space`,script_pubkey:script});tokens.push(link.token);yield*store.quote(link.token);
  }
  f.node.outputs=Array.from({length:count},(_,i)=>({...payment(i+1,price),outpoint:String(i+1).padStart(64,'0')+':0'}));yield*store.observe();
  const listener=yield*serveOperator(store,Effect.succeed(credential));
  const proxy=yield*Effect.promise(()=>faultProxy(t,listener.url));
  const token=join(f.root,'operator-token');writeFileSync(token,credential,{mode:0o600});
  function write(){chain.tipHeight=f.node.tip;writeFileSync(join(f.root,'chain.json'),JSON.stringify(chain));}
  const command=async(mode,bid='b1',operatorUrl=proxy.url,database=f.config.database)=>{
   write();const args=[new URL('./controller-case-driver.py',import.meta.url).pathname,mode,operatorUrl,token,database,f.config.journalDirectory,f.root,bid];
   try{const p=await promisify(execFile)('python3',args,{maxBuffer:4*1024*1024});const after=JSON.parse(readFileSync(join(f.root,'chain.json'),'utf8'));Object.assign(chain,after);return JSON.parse(p.stdout);}
   catch(e){if(e.code===9){Object.assign(chain,JSON.parse(readFileSync(join(f.root,'chain.json'),'utf8')));return {crashed:9};}throw e;}
  };
  const prepare=async()=>{const p=await command('prepare');assert.equal(p.error,null,JSON.stringify(p.error));chain.root=p.batches.at(-1).root;chain.roots[chain.root]=null;return p;};
  const issued=async()=>{await prepare();const p=await command('issue');assert.equal(p.error,null,JSON.stringify(p.error));return p;};
  const ready=async()=>{await issued();chain.minedHeight=50;chain.roots[chain.root]=50;chain.latestRoot=chain.root;const p=await command('certify');assert.equal(p.error,null,JSON.stringify(p.error));return p;};
  return yield*Effect.promise(()=>callback({f,store,tokens,chain,control,proxy,command,prepare,issued,ready,write}));
 }));
}
export const b=(out,id='b1')=>out.batches.find(b=>b.bid===id);
export const sent=out=>out.subs.broadcasts.length;
export const assertError=(out,pattern)=>assert.match(out.error?.message??'',pattern);
export async function cancelled(w,index=0){return run(w.store.cancel(w.tokens[index]));}
export async function rejectCancel(w,index=0){await assert.rejects(run(w.store.cancel(w.tokens[index])),/issuing/);}
export async function supersede(w,delivered=false){
 if(delivered)await w.command('publish');
 w.f.node.tip=300;w.chain.minedHeight=null;w.chain.roots[w.chain.root]=null;w.chain.conflictActive=true;
 const out=await w.command('supersede');assert.equal(out.error,null,JSON.stringify(out.error));return out;
}
