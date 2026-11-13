import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Effect } from "effect";
import { SalesStore } from "../../src/application/store.ts";
import { validP2tr } from "../../src/recipient.ts";
import { restoreApplication } from "../../src/application/recovery.ts";
import { fixture, payment, setup, use } from "./application-fixture.ts";
import { recovered } from "./recovery-fixture.ts";
import { controllerFixture } from "./reconciliation-fixture.ts";
const run=<A,E>(op:Effect.Effect<A,E,import("effect").Scope.Scope>)=>Effect.runPromise(Effect.scoped(op));
function scripts(count:number){const result:string[]=[];for(let x=1;result.length<count;x++){const s="5120"+x.toString(16).padStart(64,"0");if(validP2tr(s))result.push(s);}return result;}
test("K8: conversion review never decreases and acknowledged restore pauses until explicit resume without another threshold",async (t)=>{
 const f=fixture(t),tokens:string[]=[],keys=scripts(13);let pausedToken="";
 f.adapters.snapshot=()=>Effect.succeed({tip:f.node.tip,tipHash:"a".repeat(64),outputs:structuredClone(f.node.outputs)});
 await use(f,store=>Effect.gen(function*(){
  yield* setup(store,20);yield* store.listName("premium@space",10_000);
  for(let i=0;i<12;i++){const request=yield* store.request({handle:`n${i}@space`,script_pubkey:keys[i]});tokens.push(request.token);yield* store.quote(request.token);}
  f.node.outputs=Array.from({length:10},(_,i)=>payment(i+1,1000,3));yield* store.observe();
  assert.equal((yield* store.operatorStatus()).paused,true);
  pausedToken=(yield* store.request({handle:"n15@space",script_pubkey:keys[12]})).token;
  yield* Effect.promise(()=>assert.rejects(Effect.runPromise(store.quote(pausedToken)),/sales are paused/));
  yield* store.cancel(tokens[0]!);f.node.outputs.shift();yield* store.observe();
  f.node.outputs.push(payment(11,1000,3));yield* store.observe();
  assert.equal((yield* store.order(tokens[10]!)).status,"converted");assert.equal((yield* store.operatorStatus()).paused,true);
 }));
 const config={...f.config,database:join(f.root,"conversion-history-restored.db")};await run(restoreApplication(config));
 const before=await recovered(config);assert.equal(before.state.settings.paused,true);assert.equal(before.state.settings.conversions.length,11);
 assert.equal(new Set(before.state.settings.conversions).size,11);
 const controller=controllerFixture();assert.equal((await run(SalesStore.reconcileRecovery(config,f.adapters,controller.controller))).ready,true);
 await use({...f,config},store=>Effect.gen(function*(){
  assert.equal((yield* store.operatorStatus()).paused,true);yield* store.pause(false);
  f.node.outputs.push(payment(12,1000,3));yield* store.observe();
  assert.equal((yield* store.order(tokens[11]!)).status,"converted");assert.equal((yield* store.operatorStatus()).paused,false);
  assert.equal((yield* store.quote(pausedToken)).acknowledged,true);
 }));
});
