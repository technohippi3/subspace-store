import { Effect } from "effect";
import { proofHash, type RecoveryInventory, type RecoveryStatement } from "../../src/application/reconciliation-records.ts";
import type { RecoveryController } from "../../src/application/reconciliation.ts";
import { ApplicationError } from "../../src/application/records.ts";

export function mockStatement(i:RecoveryInventory):RecoveryStatement{
  return {...Object.fromEntries(["version","store","sourceSequence","sequence","tipHeight","tipHash"].map(k=>[k,i[k as keyof RecoveryInventory]])),
    entries:i.entries.map(e=>({entry:e.entry,root:e.root,space:e.space,oids:e.oids,delegate:e.delegate,
      mode:e.closed?"closed":e.superseded?"superseded":e.delegate?"observed":"unsent",
      walletTxid:e.superseded?e.conflictTxid:e.delegate?e.txid??"a".repeat(64):null,
      observation:e.delegate&&!e.closed&&!e.superseded?{txid:e.txid??"a".repeat(64),tipHeight:i.tipHeight,tipHash:i.tipHash,minedHeight:50,rootHeight:50,anchorHeight:i.tipHeight}:null})),
    spaces:i.spaces.map(space=>({space,subsRoot:null,chainRoot:null,subsTxid:null,ahead:null}))} as RecoveryStatement;
}
export function controllerFixture(){
  const control={valid:true,down:false,confirms:0,run:0,alter:null as ((s:RecoveryStatement)=>void)|null,after:null as (()=>void)|null};
  const controller:RecoveryController={
    run:i=>Effect.sync(()=>{control.run++;const statement=mockStatement(i);control.alter?.(statement);control.after?.();return{statement,position:1,proofHash:proofHash(statement)};}),
    verify:()=>control.valid?Effect.void:Effect.fail(new ApplicationError({code:"unavailable",message:"mock recovery chain proof unavailable"})),
    confirm:()=>Effect.gen(function*(){control.confirms++;if(control.down)return yield* Effect.fail(new ApplicationError({code:"unavailable",message:"mock controller journal unavailable"}));})};
  return {controller,control};
}
