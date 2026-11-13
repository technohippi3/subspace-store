import {test} from "node:test";
import assert from "node:assert/strict";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {Effect,Exit,Scope} from "effect";
import {RecoveryTwin} from "../../model/recovery-generated.ts";
import type {Payment as ModelPayment} from "../../model/seller.ts";
import {SalesStore} from "../../src/application/store.ts";
import {decode} from "../../src/application/records.ts";
import {configuration} from "../../src/refunds/book.ts";
import {restoreApplication} from "../../src/application/recovery.ts";
import {validP2tr} from "../../src/recipient.ts";
import {familyFixture,feeCoin,mine} from "./refund-families-fixture.ts";
import {setup} from "./application-fixture.ts";
import {controllerFixture} from "./reconciliation-fixture.ts";
const run=<A,E>(value:Effect.Effect<A,E>)=>Effect.runPromise(value);
const scoped=<A,E>(value:Effect.Effect<A,E,Scope.Scope>)=>Effect.runPromise(Effect.scoped(value));

test("H7: seeded restore twins compare independent sales finances attempts authorizations alerts destinations and cancellation finality after every operation",async(t)=>{
 let operations=0,losses=0,groups=0,attempts=0,authorizations=0,alerts=0,pendingUndone=0;
 for(const seed of [19,71,311]){
  const f=familyFixture(t),oracle=new RecoveryTwin(),links=new Map<number,string>(),destinations=new Map<number,number>();
  let config=f.config,scope=Scope.makeUnsafe(),store=await run(Scope.provide(scope)(SalesStore.open(config,f.adapters))),randomState=seed;
  const random=(n:number)=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState%n;};
  const keys:string[]=[];for(let x=1;keys.length<4;x++){const key="5120"+x.toString(16).padStart(64,"0");if(validP2tr(key))keys.push(key);}
  let payments:ModelPayment[]=[],pending:number|null=null;
  const actualState=async()=>{const db=new DatabaseSync(config.database,{readOnly:true});try{const records=(db.prepare("select kind,key,value from records order by kind,key").all() as {kind:string;key:string;value:string}[]).map(row=>({...row,value:JSON.parse(row.value)}));return decode(records,config.riskBudgetSats,configuration({version:1,policy:config.refundPolicy,merchantDestinations:config.merchantDestinations}));}finally{db.close();}};
  async function compare(label:string){
   operations++;const model=oracle.seller.snapshot(),status=await run(store.operatorStatus());assert.equal(status.paused,model.paused,label);
   const names=(await run(store.catalog())).listings;assert.deepEqual(names.map(n=>[n.handle,n.price_sats]),model.names.map(n=>[n.handle,n.price]),label);
   for(const expected of model.orders){const actual=await run(store.order(links.get(expected.id)!));const money=oracle.funds.balances(`o${expected.id}`);
    assert.equal(actual.status,pending===expected.id?"converted":expected.state,`${label} state ${expected.id}`);assert.equal(actual.price_sats,expected.price,label);
    assert.equal(actual.recipient_script_pubkey,expected.recipient,label);assert.equal(actual.refunded_sats,money.refunded,label);assert.equal(actual.reserved_refund_sats,money.reserved,label);assert.equal(actual.refundable_sats,Math.max(0,money.available),label);
    assert.equal(actual.cancellation,pending===expected.id?"unconfirmed":expected.state==="cancelled"?"final":null,label);
    const unknown=oracle.unknown.has(expected.id);assert.equal(actual.address,unknown?null:expected.destination?`mock-address-${destinations.get(expected.id)}`:null,label);
    assert.equal(actual.payment_history,oracle.detected.has(expected.id)?"detected":unknown?"unknown":"none",label);
   }
   assert.deepEqual(status.alerts.map(({order,kind,amount,at,deadline})=>({order,kind,amount,at,deadline})),oracle.alerts,label);
   // Inspection uses a separate read-only SQLite connection while the sole writer retains ownership.
   const state=await actualState();
   assert.deepEqual(state.orders.map(o=>({id:o.sequence,handle:o.handle,status:o.status,price:o.price,quotedPrice:o.quotedPrice,grants:o.grants})),model.orders.map(o=>({id:o.id,handle:o.handle,status:o.state,price:o.price,quotedPrice:o.quotedPrice,grants:o.holds})),label);
   assert.deepEqual(state.ownerAuthorizations.map(a=>({operation:a.operation,order:a.order,handle:a.handle,recipient:a.recipient,price:a.price,authorizedAt:a.authorizedAt})),model.ownerAuthorizations.map(a=>({operation:a.operation,order:`o${a.order}`,handle:a.handle,recipient:a.recipient,price:a.price,authorizedAt:a.authorizedAt})),label);
   assert.deepEqual(state.groups.map(g=>({id:g.id,order:Number(g.order.slice(1)),charged:g.charged,rate:g.rate,txid:g.transaction!.txid,raw:g.transaction!.raw,fee:g.transaction!.fee,buyerFee:g.transaction!.buyerFee,merchantFee:g.transaction!.merchantFee,toBuyer:g.transaction!.toBuyer})).sort((a,b)=>a.id.localeCompare(b.id)),[...oracle.groups].sort((a,b)=>a.id.localeCompare(b.id)),label);
   assert.deepEqual(state.refundAttempts.map(a=>({id:a.id,group:a.group,ordinal:a.ordinal,parent:a.parent,charged:a.charged,rate:a.rate,txid:a.transaction!.txid,raw:a.transaction!.raw,fee:a.transaction!.fee,buyerFee:a.transaction!.buyerFee,merchantFee:a.transaction!.merchantFee,toBuyer:a.transaction!.toBuyer})),oracle.attempts,label);
   assert.deepEqual(state.refundSends.map(s=>({group:s.group,txid:s.txid,calls:s.calls})).sort((a,b)=>a.txid.localeCompare(b.txid)),[...oracle.sends.values()].sort((a,b)=>a.txid.localeCompare(b.txid)),label);
  }
  async function observe(label:string){f.node.outputs=payments.map(p=>({outpoint:p.outpoint,script:"0014"+destinations.get(p.order)!.toString(16).padStart(40,"0"),sats:p.sats,confirmations:p.confirmations}));oracle.observe(f.node.now,f.node.tip,payments);await run(store.observe());oracle.acknowledge();await compare(label);}
  async function lose(label:string){
   const sends=f.sent.length,builds=f.senderState.builds;await run(Scope.close(scope,Exit.void));const before=await actualState();
   config={...config,database:join(f.root,`recovered-${seed}-${++losses}.db`)};f.journal.down=false;await scoped(restoreApplication(config));oracle.restore();pending=null;oracle.observe(f.node.now,f.node.tip,payments);
   const controller=controllerFixture();assert.equal((await scoped(SalesStore.reconcileRecovery(config,f.adapters,controller.controller))).ready,true);
   const after=await actualState();for(const key of ["groups","refundAttempts","refundSends","ownerAuthorizations","alerts","accounts"] as const)assert.deepEqual(after[key],before[key],label+" durable "+key);
   scope=Scope.makeUnsafe();store=await run(Scope.provide(scope)(SalesStore.open(config,f.adapters)));assert.equal(f.sent.length,sends,label);assert.equal(f.senderState.builds,builds,label);oracle.acknowledge();await compare(label);
   oracle.seller.pause(false);await run(store.pause(false));oracle.acknowledge();await compare(label+" explicit resume");
  }
  try{
   await run(setup(store,4));const intent={operation:seed.toString(16).padStart(32,"a"),handle:"n0@space",recipient:keys[0]!,confirm:"n0@space",expectedSequence:oracle.seller.snapshot().revision};oracle.seller.ownerInvoice(intent,{authenticated:true,journalAcknowledged:true,recoveryReady:true,issuanceReady:true});
   const preview=await run(store.seller.ownerPreview({handle:intent.handle,script_pubkey:intent.recipient}));const ownerCommand={operation:intent.operation,handle:intent.handle,script_pubkey:intent.recipient,confirm:intent.confirm,review:preview.review};const owner=await run(store.seller.ownerInvoice(ownerCommand));links.set(1,owner.order_link!.split("/").at(-1)!);destinations.set(1,1);oracle.acknowledge();await compare("owner invoice");
   for(let i=1;i<4;i++){const o=oracle.seller.request(`n${i}@space`,keys[i]!);oracle.seller.quote(o.id);const request=await run(store.request({handle:`n${i}@space`,script_pubkey:keys[i]}));links.set(o.id,request.token);await run(store.quote(request.token));destinations.set(o.id,f.node.draws);oracle.acknowledge();await compare("generated invoice "+i);}
   f.node.now=10;payments=[1,2,3].map(id=>({outpoint:id.toString(16).padStart(64,"0")+":0",order:id,sats:1000,confirmations:6}));await observe("payments");
   for(const id of [2,3]){oracle.seller.cancel(id);await run(store.cancel(links.get(id)!));await run(store.setRefundDestination(links.get(id)!,`refund-${seed}-${id}`));oracle.observe(f.node.now,f.node.tip,payments);oracle.acknowledge();await compare("final cancellation "+id);}
   payments.push({outpoint:"4".repeat(64)+":0",order:2,sats:1000+random(3)*1000,confirmations:6},{outpoint:"5".repeat(64)+":0",order:3,sats:1000,confirmations:6});await observe("refund credits");
   const principal=payments.filter(p=>p.order===2).reduce((sum,p)=>sum+p.sats,0),one=await run(store.prepareRefund("o2","cancellation","buyer"));const primary=oracle.open(one.id,2,principal,payments.filter(p=>p.order===2).map(p=>p.outpoint));oracle.acknowledge();await compare("first signed refund");await lose("loss with signed unsent refund");
   await run(store.bumpRefund(one.id,3000));const bumped=oracle.bump(one.id,3000,[...payments.filter(p=>p.order===2).map(p=>p.outpoint),feeCoin.outpoint]);oracle.acknowledge();await compare("replacement attempt");
   const two=await run(store.prepareRefund("o3","cancellation","buyer"));const other=oracle.open(two.id,3,2000,payments.filter(p=>p.order===3).map(p=>p.outpoint));oracle.acknowledge();await compare("second refund family");
   await run(store.broadcastRefund(one.id));oracle.send(one.id,bumped.txid);oracle.acknowledge();await compare("attended send");
   const winner=random(2)?primary.txid:bumped.txid;mine(f,winner,6);oracle.funds.observe(winner,6);await observe("refund settlement");
   await run(store.broadcastRefund(two.id));oracle.send(two.id,other.txid);oracle.acknowledge();await compare("second attended send");await lose("loss with settled and mempool refunds");
   for(let step=0;step<8;step++){
    f.node.now+=20+random(40);f.node.tip++;
    if(step%2===0)payments=payments.filter(p=>p.order!==1);else if(!payments.some(p=>p.order===1))payments.push({outpoint:"0".repeat(63)+"1:0",order:1,sats:1000,confirmations:6});
    const depth=step%3===0?5:6;mine(f,winner,depth);f.observations.set(other.txid,{txid:other.txid,seen:"mempool",confirmations:0,blockHash:null,inputsAvailable:false,chainInputsAvailable:true,conflicts:[]});oracle.funds.observe(winner,depth);
    await observe("seed "+seed+" generated step "+step);if(step%3===2)await lose("generated host loss "+step);
   }
   oracle.seller.ownerInvoice(intent,{authenticated:true,journalAcknowledged:true,recoveryReady:true,issuanceReady:true});assert.equal((await run(store.seller.ownerInvoice(ownerCommand))).created,false);await compare("authorization replay after generated restores");
   // An unacknowledged cancellation is local state, and never final history.
   f.journal.down=true;oracle.seller.cancel(1);oracle.observe(f.node.now,f.node.tip,payments);pending=1;await run(store.cancel(links.get(1)!));await compare("unacknowledged cancellation");pendingUndone++;await lose("loss undoes unconfirmed cancellation");
   groups+=oracle.groups.length;attempts+=oracle.attempts.length;authorizations+=oracle.seller.snapshot().ownerAuthorizations.length;alerts+=oracle.alerts.length;
  }finally{await run(Scope.close(scope,Exit.void));}
 }
 for(const [name,count] of Object.entries({operations,losses,groups,attempts,authorizations,alerts,pendingUndone}))assert(count>0,name);
 assert(operations>=100);assert(losses>=12);t.diagnostic(JSON.stringify({seeds:3,operations,losses,groups,attempts,authorizations,alerts,pendingUndone}));
});
