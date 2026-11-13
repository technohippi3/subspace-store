import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { serve } from "../../src/application/http.ts";
import { serveOperator } from "../../src/application/operator-http.ts";
import { sellerCommand, type SellerClient } from "../../src/seller-cli.ts";
import { fixture, invoice, payment, script, setup, use } from "./application-fixture.ts";

const credential="mock-seller-operator-token".padEnd(48,"x");
async function api(url:string,path:string,value?:unknown,authorized=true){
  const response=await fetch(url+path,{method:value===undefined?"GET":"POST",headers:authorized?{Authorization:`Bearer ${credential}`}:{},
    ...(value===undefined?{}:{body:typeof value==="string"?value:JSON.stringify(value)})});
  return{code:response.status,value:await response.json() as {[key:string]:any}};
}
test("K22: seller HTTP uses strict authenticated commands and one acknowledged policy path for CLI setup and later changes",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){
    const operator=yield* serveOperator(store,Effect.succeed(credential)),buyer=yield* serve(store);
    yield* Effect.promise(async()=>{
      const files=new Map<string,unknown>();
      const client:SellerClient={call:async(method,path,value)=>{assert.equal(method,value===undefined?"GET":"POST");const result=await api(operator.url,path,value);assert.equal(result.code,200,JSON.stringify(result.value));return result.value;},
        readNomination:async path=>files.get(path),reserveLink:async(path,request)=>{assert.equal(files.has(path),false);files.set(path,{request,pending:true});},
        saveLink:async(path,value)=>{files.set(path,{...(files.get(path) as object),...value});}};
      const before=f.node.observations;
      for(const raw of ['{"action":"space","space":"x","space":"other"}','{"action":"space","sp\\u0061ce":"other"}',
        '{"action":"space","space":"other","extra":true}','{"action":"pause","paused":1}','{"action":"admission","window_seconds":0,"maximum_requests":2,"maximum_orders":10}'])
        assert.equal((await api(operator.url,"/operator/seller/preview",raw)).code,400);
      assert.equal(f.node.observations,before);
      assert.equal((await api(operator.url,"/operator/seller/preview",{action:"space",space:"space"},false)).code,401);
      assert.equal((await api(buyer.url,"/operator/seller/preview",{action:"space",space:"space"})).code,404);
      const preview=await sellerCommand(["space","add","space"],client) as {applied:boolean};assert.equal(preview.applied,false);
      assert.equal((await store.operatorStatus().pipe(Effect.runPromise)).seller.spaces.length,0);
      await sellerCommand(["space","add","space","--apply"],client);
      await sellerCommand(["name","list","n0@space","1000","--apply"],client);
      await sellerCommand(["admission","set","600","2","10","--apply"],client);
      await sellerCommand(["resume","--apply"],client);
      const status=await sellerCommand(["status"],client) as {seller:{explicit_limits:boolean}};assert.equal(status.seller.explicit_limits,true);
      assert.equal(f.node.draws,0);
      await sellerCommand(["space","add","later","--apply"],client);
      await sellerCommand(["name","price","n0@space","1200","--apply"],client);
      assert.equal(f.node.draws,0);
      await assert.rejects(()=>sellerCommand(["name","price","n0@space","1000","--unknown"],client));
    });
  }));
});
test("K23: material previews survive irrelevant polling but reject new holds, expiry and price or reservation changes",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);
    const action={action:"withdrawal" as const,handle:"n0@space",withdrawn:true};
    const before=yield* store.seller.preview(action);f.node.now=10;f.node.tip=11;yield* store.observe();
    assert.equal((yield* store.seller.preview(action)).review,before.review);
    const old=yield* invoice(store);yield* Effect.promise(()=>assert.rejects(Effect.runPromise(store.seller.apply(action,before.review)),/changed/));
    const held=yield* store.seller.preview(action);f.node.now=910;yield* store.observe();
    yield* Effect.promise(()=>assert.rejects(Effect.runPromise(store.seller.apply(action,held.review)),/changed/));
    assert.equal((yield* store.order(old.token)).status,"unpaid");
    const fresh=yield* store.seller.preview(action);f.node.now=911;
    assert.equal((yield* store.seller.apply(action,fresh.review)).acknowledged,true);
    assert.equal((yield* store.catalog()).listings[0]!.available,false);
  }));
});
test("K25: seller journal outage returns pending without allocating and repeat preview acknowledges the same durable policy",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);
    const operator=yield* serveOperator(store,Effect.succeed(credential));yield* Effect.promise(async()=>{
      const command={action:"reservation",handle:"n0@space",reserved:true};const preview=await api(operator.url,"/operator/seller/preview",command);
      f.journal.down=true;const pending=await api(operator.url,"/operator/seller/apply",{...command,review:preview.value.review});
      assert.equal(pending.code,503);assert.equal(pending.value.acknowledged,false);assert.equal(f.node.draws,0);
      f.journal.down=false;const next=await api(operator.url,"/operator/seller/preview",command);
      const final=await api(operator.url,"/operator/seller/apply",{...command,review:next.value.review});assert.equal(final.code,200);assert.equal(final.value.acknowledged,true);
    });
  }));
});
test("K30: HTTP aggregate creation refuses with 429 and cannot identify or deduplicate a buyer by their unsigned nomination",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);const command={action:"admission" as const,window_seconds:600,maximum_requests:2,maximum_orders:3};
    const preview=yield* store.seller.preview(command);yield* store.seller.apply(command,preview.review);
    const buyer=yield* serve(store);yield* Effect.promise(async()=>{
      const input={handle:"n0@space",script_pubkey:script},a=await api(buyer.url,"/requests",input,false),b=await api(buyer.url,"/requests",input,false);
      assert.equal(a.code,201);assert.equal(b.code,201);assert.notEqual(a.value.order_link,b.value.order_link);
      const refused=await api(buyer.url,"/requests",{handle:"n1@space",script_pubkey:script},false);assert.equal(refused.code,429);
      assert.equal(f.node.draws,0);assert.equal((await api(buyer.url,a.value.order_link,undefined,false)).code,200);
    });
  }));
});
test("K34: owner HTTP and CLI preserve exact intent, follow a fresh browser link and retry a saved operation without redisclosure",async(t)=>{
  const f=fixture(t);await use(f,store=>Effect.gen(function*(){yield* setup(store);
    const command={action:"reservation" as const,handle:"n0@space",reserved:true};const preview=yield* store.seller.preview(command);yield* store.seller.apply(command,preview.review);
    const operator=yield* serveOperator(store,Effect.succeed(credential)),buyer=yield* serve(store);
    yield* Effect.promise(async()=>{
      const files=new Map<string,any>([["request.json",{handle:"n0@space",script_pubkey:script}]]);
      const client:SellerClient={call:async(_method,path,value)=>{const response=await api(operator.url,path,value);if(response.code!==200)throw Error(JSON.stringify(response.value));return response.value;},
        readNomination:async path=>files.get(path),reserveLink:async(path,request)=>{assert.equal(files.has(path),false);files.set(path,{request,pending:true});},
        saveLink:async(path,value)=>{files.set(path,{...files.get(path),...value});}};
      const args=["owner","invoice","request.json","--operation","a".repeat(32),"--confirm","n0@space","--save-link","private-record","--apply"];
      const result=await sellerCommand(args,client) as {[key:string]:unknown};assert.equal(result.link_saved,true);
      const saved=files.get("private-record");assert.match(saved.order_link,/^\/o\/[A-Za-z0-9_-]{32}$/);
      assert.equal(JSON.stringify(result).includes(saved.order_link),false);
      const page=await fetch(buyer.url+saved.order_link);assert.equal(page.status,200);const html=await page.text();
      assert.match(html,/mock-address-1/);assert.match(html,/for="refund-address"/);assert.equal((html.match(/id="address"/g)??[]).length,1);
      const retry=await sellerCommand(["owner","retry","private-record","--save-link","retry-record","--apply"],client) as {[key:string]:unknown};
      assert.equal(retry.created,false);assert.equal(retry.link_saved,false);assert.equal(files.get("retry-record").order_link,null);assert.equal(f.node.draws,1);
      assert.equal((await api(operator.url,"/operator/owner-orders",saved.request,false)).code,401);
      assert.equal((await api(buyer.url,"/operator/owner-orders",saved.request)).code,404);
      assert.equal((await api(operator.url,"/operator/owner-orders",{...saved.request,confirm:"n1@space"})).code,400);
      assert.equal((await api(operator.url,"/operator/owner-orders",{...saved.request,review:"b".repeat(64)})).code,409);
    });
    f.node.outputs=[payment(1)];yield* store.beginIssuance("o1");
  }));
});
