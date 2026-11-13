import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { nodeFixture } from "./core-fixture.ts";
import { observeIdentity } from "../../src/bitcoin/observe-identity.ts";
import { GENESIS, descriptorFingerprint } from "../../src/bitcoin/identity.ts";
const descriptors = { descriptors: [{desc:"tr(mock-public-expression/*)#fixture",active:true,internal:false}] };
test("identity is read-only, network specific, public-descriptor only and qualified at one ready tip",async (t)=>{
  for(const network of ["main","regtest"] as const){
    const f=await nodeFixture(t);f.state.chain=network;
    f.state.mutate=call=>call.method==="getblockhash"?{result:GENESIS[network]}:
      call.method==="listdescriptors"?{result:descriptors}:undefined;
    const result=await Effect.runPromise(observeIdentity({...f.coreConfig,network}));
    assert.equal(result.network,network);assert.equal(result.genesis,GENESIS[network]);
    assert.equal(result.descriptorHash,descriptorFingerprint(descriptors));
    assert.deepEqual(f.calls.find(c=>c.method==="listdescriptors")?.params,[false]);
    assert(!f.calls.some(c=>/send|sign|import|create|unlock|newaddress/.test(c.method)));
  }
});
test("wrong genesis and unavailable scans never produce an identity",async (t)=>{
  const f=await nodeFixture(t);
  f.state.mutate=call=>call.method==="getblockhash"?{result:GENESIS.main}:
    call.method==="listdescriptors"?{result:descriptors}:undefined;
  await assert.rejects(Effect.runPromise(observeIdentity(f.coreConfig)),/identity differs/);
  f.state.scanning=true;
  await assert.rejects(Effect.runPromise(observeIdentity(f.coreConfig)),/not ready/);
});
test("a moving chain cannot bind an observation assembled at two different tips",async (t)=>{
  const f=await nodeFixture(t);let reads=0;
  f.state.mutate=call=>{
    if(call.method==="getblockhash")return{result:GENESIS.regtest};
    if(call.method==="listdescriptors")return{result:descriptors};
    if(call.method==="getblockchaininfo"&&++reads===2){f.state.hash="f".repeat(64);f.state.walletTip=f.state.hash;f.state.height++;}
    return undefined;
  };
  await assert.rejects(Effect.runPromise(observeIdentity(f.coreConfig)),/chain changed/);
});
