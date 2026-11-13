import {createServer} from "node:http";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import type {TestContext} from "node:test";
import type {RuntimeConfig} from "../../src/runtime/config.ts";
import type {runtimeFixture} from "./runtime-fixture.ts";

export async function recoveryHost(t:TestContext,core:Awaited<ReturnType<typeof runtimeFixture>>,config:RuntimeConfig){
  const state={root:null as string|null,chainRoot:null as string|null,txid:null as string|null,walletTip:core.state.height,
    walletIds:[] as string[],network:"regtest",input:"d".repeat(64),txRoot:"a".repeat(64),transactionId:"c".repeat(64)};
  core.state.mutate=call=>{
    if(call.method==="getserverinfo")return{result:{network:state.network,tip:{hash:core.state.hash},ready:true}};
    if(call.method==="walletgetinfo")return{result:{tip:state.walletTip}};
    if(call.method==="walletlisttransactions")return{result:state.walletIds.map(txid=>({txid}))};
    if(call.method==="getcommitment")return{result:state.chainRoot?{state_root:state.chainRoot,block_height:90}:null};
    if(call.method==="getblockhash"&&call.params[0]!==0)return{result:"b".repeat(64)};
    if(call.method==="getrawtransaction")return{result:{txid:state.transactionId,blockhash:"b".repeat(64),
      vin:[{txid:state.input,vout:0}],vout:[{scriptPubKey:{hex:"6a20"+state.txRoot}}]}};
    return undefined;
  };
  const server=createServer(async(request,response)=>{
    for await(const _chunk of request){}
    const value=request.url==="/rpc/endpoints"?{wallet:"mock-operator-wallet"}:request.url==="/rpc/spaced"?
      {result:{network:state.network,tip:{hash:core.state.hash}}}:{root:state.root,txid:state.txid};
    response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw Error("missing subs fixture");
  t.after(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));
  const root=join(core.root,"controller-recovery"),journal=join(root,"journal");mkdirSync(journal,{recursive:true});
  const host={network:"regtest",store:{implementation:"typescript",url:`http://127.0.0.1:${config.listen.operator}`,
    operator_token_file:config.credentials.operator,db:config.database,journal_dir:config.journalDirectory},
    controller:{dir:join(root,"state"),journal_dir:journal,operator_wallet:"mock-operator-wallet"},
    bitcoind:{url:config.core.url,cookie_file:config.core.cookiePath},spaced:{url:config.core.url,cookie_file:config.core.cookiePath},
    subs:{url:`http://127.0.0.1:${address.port}`,data_dir:join(root,"subs"),stop_command:["/bin/false"],start_command:["/bin/false"],capabilities:{attach_txid:true}},
    relay:{url:"http://127.0.0.1:9"},verifier:join(root,"mock-verifier")};
  const file=join(root,"host.json");writeFileSync(file,JSON.stringify(host),{mode:0o600});
  return{state,host,file,journal};
}
