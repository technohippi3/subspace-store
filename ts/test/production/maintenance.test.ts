import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { ApplicationError } from "../../src/application/records.ts";
import { serveOperator } from "../../src/application/operator-http.ts";
import { serve } from "../../src/application/http.ts";
import { fixture, invoice, setup, use } from "./application-fixture.ts";
import { certificateFixture } from "./certificate-fixture.ts";
import { armed } from "./commitment-fixture.ts";
import { sendingFixture, settledRefund } from "./refund-sending-fixture.ts";
import { supersessionFixture } from "./supersession-fixture.ts";

test("O97: authenticated maintenance inspection requires paused admission and reports holds and unavailable chain or journal without sending",async(t)=>{
  const f=fixture(t);let down=false;
  f.adapters.snapshot=()=>down?Effect.fail(new ApplicationError({code:"unavailable",message:"mock node unavailable"})):
    Effect.succeed({tip:f.node.tip,tipHash:"d".repeat(64),outputs:structuredClone(f.node.outputs)});
  await use(f,store=>Effect.gen(function*(){yield* setup(store);
    assert.equal((yield* store.seller.maintenance()).ready,false);
    const one=yield* invoice(store);yield* store.pause(true);
    const held=yield* store.seller.maintenance();assert.deepEqual(held.blockers,[{kind:"active_hold",id:"o1"}]);assert.equal(held.reviewCount,0);
    yield* store.cancel(one.token);assert.equal((yield* store.seller.maintenance()).ready,true);
    down=true;const missing=yield* store.seller.maintenance();assert.equal(missing.chain,null);assert(missing.blockers.some(b=>b.kind==="chain_unavailable"));
    down=false;f.journal.down=true;assert((yield* store.seller.maintenance()).blockers.some(b=>b.kind==="journal_unavailable"));f.journal.down=false;
    const token="mock-maintenance-credential".padEnd(48,"x"),operator=yield* serveOperator(store,Effect.succeed(token)),buyer=yield* serve(store);
    yield* Effect.promise(async()=>{
      assert.equal((await fetch(operator.url+"/operator/maintenance")).status,401);
      assert.equal((await fetch(buyer.url+"/operator/maintenance")).status,404);
      const response=await fetch(operator.url+"/operator/maintenance",{headers:{Authorization:`Bearer ${token}`}});
      assert.equal(response.status,200);const value=await response.json() as {ready:boolean;paused:boolean;reviewCount:number};
      assert.equal(value.ready,true);assert.equal(value.paused,true);assert.equal(value.reviewCount,0);
    });assert.equal(f.node.draws,1);
  }));
});
test("O97: armed entries block maintenance until every member has confirmed final fulfilled history",async(t)=>{
  const f=certificateFixture(t);await use(f,store=>Effect.gen(function*(){yield* f.prepare(store);yield* store.pause(true);
    const blocked=yield* store.seller.maintenance();assert(blocked.blockers.some(b=>b.kind==="armed_entry"&&b.id===armed.entry));
    for(const oid of armed.oids){const cert=yield* store.registry.certificates.accept(f.packet(oid));
      yield* store.registry.deliveries.fulfill({...armed,oid,revision:1,certificateHash:cert.hash,relayRoot:armed.root,relayHeight:50,proofHash:"e".repeat(64)});}
    const ready=yield* store.seller.maintenance();assert.equal(ready.ready,true);assert.deepEqual(ready.blockers,[]);assert.equal(ready.reviewCount,2);
  }));
});
test("O97: an absent attempted refund blocks maintenance while positive observation allows a checkpoint without a retry",async(t)=>{
  const f=sendingFixture(t);await use(f,store=>Effect.gen(function*(){const one=yield* Effect.promise(()=>settledRefund(store,f));
    f.senderState.failure=true;yield* store.broadcastOperatorRefund(one.group.id,one.group.txid!);yield* store.pause(true);
    const absent=yield* store.seller.maintenance();assert(absent.blockers.some(b=>b.kind==="uncertain_refund_send"&&b.id===one.group.txid));
    assert.equal(f.sent.length,1);assert.equal(f.senderState.builds,1);
    f.observations.set(one.group.txid!,{txid:one.group.txid!,seen:"mempool",confirmations:0,blockHash:null,inputsAvailable:false,conflicts:[]});
    assert.equal((yield* store.seller.maintenance()).ready,true);assert.equal(f.sent.length,1);assert.equal(f.senderState.builds,1);
    assert.equal((yield* store.order(one.token)).reserved_refund_sats,10000);
  }));
});
test("O97: freshly verified superseded history permits maintenance but unknown or reversed proof never hides an armed entry",async(t)=>{
  const f=supersessionFixture(t);await use(f,store=>Effect.gen(function*(){const prepared=yield* f.prepare(store);
    yield* store.registry.supersessions.accept(prepared.input);yield* store.pause(true);yield* store.cancel(prepared.tokens[0]!);
    const checked=f.control.checks;assert.equal((yield* store.seller.maintenance()).ready,true);assert(f.control.checks>checked);
    f.control.down=true;const unknown=yield* store.seller.maintenance();assert.equal(unknown.ready,false);
    assert(unknown.blockers.some(b=>b.kind==="chain_unavailable"));assert(unknown.blockers.some(b=>b.kind==="armed_entry"));
    f.control.down=false;f.control.valid=false;const reversed=yield* store.seller.maintenance();assert.equal(reversed.ready,false);
    assert(reversed.blockers.some(b=>b.kind==="armed_entry"));
  }));
});
