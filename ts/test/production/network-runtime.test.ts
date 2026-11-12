import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { configuration, type RuntimeConfig } from "../../src/runtime/config.ts";
import { startRuntime } from "../../src/runtime/server.ts";
import { recoveryCommand } from "../../src/runtime/recovery.ts";
import { CoreAdapter } from "../../src/bitcoin/core.ts";
import { CoreRefundSender } from "../../src/bitcoin/refund-sender.ts";
import { SalesStore } from "../../src/application/store.ts";
import { ApplicationError } from "../../src/application/records.ts";
import { GENESIS, descriptorFingerprint } from "../../src/bitcoin/identity.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { script } from "./application-fixture.ts";

const descriptors = { descriptors: [{desc:"tr(mock-public-expression/*)#fixture",active:true,internal:false}] };
const descriptorHash = descriptorFingerprint(descriptors);
const journalText=(directory:string)=>readdirSync(directory).sort().map(name=>readFileSync(join(directory,name),"utf8")).join("\n");
const scoped = <A,E>(work: Effect.Effect<A,E,import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(work));
function publicConfig(config: RuntimeConfig): RuntimeConfig {
  const maintenanceLock = join(config.database + ".maintenance.lock");
  if (!existsSync(maintenanceLock)) writeFileSync(maintenanceLock,"",{mode:0o644});
  return {...config,version:2,network:"main",maintenanceLock,installation:{genesis:GENESIS.main,descriptorHash}};
}
test("O120: version 2 requires explicit supported genesis and public descriptor fingerprint while version 1 stays regtest",async(t)=>{
  const f=await runtimeFixture(t),config=publicConfig(f.config);
  assert.deepEqual(configuration(config),config);
  for(const changed of [{...f.config,network:"main"},{...config,installation:undefined},{...config,maintenanceLock:undefined},
    {...config,network:"signet"},{...config,installation:{genesis:GENESIS.regtest,descriptorHash}},
    {...config,installation:{genesis:GENESIS.main,descriptorHash:"bad"}},
    {...config,installation:{...config.installation,descriptor:"sensitive-marker"}}])
    assert.throws(()=>configuration(changed),/invalid runtime configuration/);
  assert.equal(f.calls.length,0);
});
test("O121: bound startup refuses wallet key substitution and all version 1 relabeling before listeners or sends",async(t)=>{
  const f=await runtimeFixture(t);
  await scoped(startRuntime(f.config));
  const before=journalText(f.config.journalDirectory);
  f.state.mutate=call=>call.method==="listdescriptors"?{result:{descriptors:[{desc:"tr(other-public-expression/*)#fixture"}]}}:undefined;
  await assert.rejects(scoped(startRuntime(f.config)),/identity differs|validation failed/);
  assert.equal(journalText(f.config.journalDirectory),before);
  await assert.rejects(fetch(`http://127.0.0.1:${f.config.listen.operator}/operator/status`));
  assert(!f.calls.some(c=>/send|sign|import|create|unlock|newaddress/.test(c.method)));
});
test("O122: main bootstrap exposes authenticated seller setup but central admission withholds all invoices until explicit limits",async(t)=>{
  const f=await runtimeFixture(t);f.state.chain="main";
  await scoped(Effect.gen(function*(){
    const runtime=yield* startRuntime(publicConfig(f.config));
    yield* Effect.promise(async()=>{
      const status=()=>f.api(runtime.operator,"/operator/status",f.operator);
      assert.equal((await status()).value.production_ready,false);
      assert.equal((await status()).value.paused,true);
      assert.equal((await f.api(runtime.operator,"/operator/seller/preview",undefined,{action:"space",space:"space"})).status,401);
      for(const command of [{action:"space",space:"space"},{action:"listing",handle:"n0@space",price_sats:1000},{action:"pause",paused:false}]){
        const preview=await f.api(runtime.operator,"/operator/seller/preview",f.operator,command);
        assert.equal(preview.status,200);
        assert.equal((await f.api(runtime.operator,"/operator/seller/apply",f.operator,{...command,review:preview.value.review})).status,200);
      }
      assert.equal((await status()).value.production_ready,false);
      const request=await Effect.runPromise(runtime.store.request({handle:"n0@space",script_pubkey:script}));
      await assert.rejects(Effect.runPromise(runtime.store.quote(request.token)),/explicit installation admission limits/);
      const nomination={handle:"n0@space",script_pubkey:script,operation:"a".repeat(32),confirm:"n0@space"};
      const preview=await f.api(runtime.operator,"/operator/owner-orders/preview",f.operator,{handle:nomination.handle,script_pubkey:nomination.script_pubkey});
      assert.equal(preview.status,200);
      const owner=await f.api(runtime.operator,"/operator/owner-orders",f.operator,{...nomination,review:preview.value.review});
      assert.equal(owner.status,409);
      assert(!f.calls.some(c=>c.method==="getnewaddress"));
      const limits={action:"admission",window_seconds:600,maximum_requests:12,maximum_orders:100};
      const review=await f.api(runtime.operator,"/operator/seller/preview",f.operator,limits);
      assert.equal((await f.api(runtime.operator,"/operator/seller/apply",f.operator,{...limits,review:review.value.review})).status,200);
      assert.equal((await status()).value.production_ready,true);
      assert.equal((await Effect.runPromise(runtime.store.quote(request.token))).acknowledged,true);
      const text=journalText(f.config.journalDirectory);
      assert(!text.includes("mock-public-expression"));
      assert(!text.includes(f.operator));assert(!text.includes(f.subs));
    });
  }));
});
test("O123: journal restore preserves bound installation and version 1 cannot adopt main history even offline",async(t)=>{
  const f=await runtimeFixture(t);f.state.chain="main";const config=publicConfig(f.config);
  await scoped(startRuntime(config));
  const restored={...config,database:join(f.root,"restored.db")};
  assert.equal((await scoped(recoveryCommand("restore",restored))).acknowledged,true);
  const { DatabaseSync }=await import("node:sqlite"),db=new DatabaseSync(restored.database);
  try {const row=db.prepare("select value from records where kind='installation_identity'").get() as {value:string};assert.equal(JSON.parse(row.value).network,"main");}finally{db.close();}
  const v1={...f.config,database:join(f.root,"wrong-network.db")};
  await assert.rejects(scoped(recoveryCommand("restore",v1)),/identity differs|validation failed/);
  const calls=f.calls.length;
  await assert.rejects(scoped(startRuntime(f.config)),/identity differs|validation failed/);
  assert.equal(f.calls.length,calls);
  assert(!f.calls.some(c=>/send|sign|import|create|unlock|newaddress/.test(c.method)));
});
test("O124: live Core wallet identity guard blocks address allocation and refund guards after a descriptor substitution",async(t)=>{
  const f=await runtimeFixture(t),identity={version:1 as const,network:"regtest" as const,genesis:GENESIS.regtest,wallet:"merchant",descriptorHash};
  const core=await Effect.runPromise(CoreAdapter.make({...f.coreConfig,identity:()=>identity}));
  await Effect.runPromise(core.checkReady());
  f.state.mutate=call=>call.method==="listdescriptors"?{result:{descriptors:[{desc:"tr(other-public-expression/*)#fixture"}]}}:undefined;
  await assert.rejects(Effect.runPromise(core.newDestination()),/identity differs|validation failed/);
  const sender=await Effect.runPromise(CoreRefundSender.make({...f.coreConfig,identity:()=>identity}));
  let permission=0;
  await assert.rejects(Effect.runPromise(sender.broadcast({txid:"c".repeat(64),raw:"00",vbytes:100,
    fee:200,buyerFee:200,merchantFee:0,toBuyer:9800,
    inputs:[{outpoint:"d".repeat(64)+":0",script:"0014"+"e".repeat(40),sats:10000,owner:"order"}],
    outputs:[{address:"buyer",script:"0014"+"f".repeat(40),sats:9800,role:"buyer"}]},
    Effect.sync(()=>{permission++;return true;}),{tip:f.state.height,tipHash:f.state.hash})),/identity differs|validation failed/);
  assert.equal(permission,0);
  assert(!f.calls.some(c=>/send|sign|newaddress/.test(c.method)));
});
test("O125: an existing unbound application cannot be adopted as a fresh main installation",async(t)=>{
  const f=await runtimeFixture(t);
  await scoped(SalesStore.open(f.config,{clock:()=>0,snapshot:()=>Effect.succeed({tip:0,outputs:[]}),
    newDestination:Effect.fail(new ApplicationError({code:"unavailable",message:"wallet disabled"}))}));
  const before=journalText(f.config.journalDirectory);f.state.chain="main";
  await assert.rejects(scoped(startRuntime(publicConfig(f.config))),/identity differs|validation failed/);
  assert.equal(f.calls.length,0);assert.equal(journalText(f.config.journalDirectory),before);
  await assert.rejects(fetch(`http://127.0.0.1:${f.config.listen.operator}/operator/status`));
});
test("O152: version 2 enables the cold-start barrier internally before its buyer and operator listeners", async (t) => {
  const f = await runtimeFixture(t); f.state.chain = "main"; f.state.txids = [];
  const config = publicConfig(f.config); let token = "";
  await scoped(Effect.gen(function* () {
    const runtime = yield* startRuntime(config);
    yield* runtime.store.listName("n0@space", 1000);
    const command = { action: "admission" as const, window_seconds: 600, maximum_requests: 12, maximum_orders: 100 };
    const preview = yield* runtime.store.seller.preview(command);
    yield* runtime.store.seller.apply(command, preview.review);
    yield* runtime.store.pause(false);
    token = (yield* runtime.store.request({ handle: "n0@space", script_pubkey: script })).token;
    assert.equal((yield* runtime.store.quote(token)).payment_request_open, true);
  }));
  await scoped(Effect.gen(function* () {
    const runtime = yield* startRuntime(config);
    yield* Effect.promise(async () => {
      const status = await f.api(runtime.operator, "/operator/status", f.operator);
      assert.equal(status.status, 200); assert.equal(status.value.paused, true);
      assert.equal(status.value.unknown_payment_history, 1);
      const view = await f.api(runtime.buyer, "/orders/" + token);
      assert.equal(view.status, 200); assert.equal(view.value.address, null);
      assert.equal(view.value.payment_history, "unknown"); assert.equal(view.value.payment_request_open, false);
    });
  }));
});
