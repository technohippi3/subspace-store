import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {join} from "node:path";
import {Effect} from "effect";
import {fixture,setup,invoice,use} from "./application-fixture.ts";
import {restoreApplication} from "../../src/application/recovery.ts";
import {SalesStore} from "../../src/application/store.ts";
import {recovered} from "./recovery-fixture.ts";
import {controllerFixture} from "./reconciliation-fixture.ts";

test("O94: process death after journaled completion leaves the local startup latch closed until a fresh confirmed retry",async(t)=>{
  const f=fixture(t);f.adapters.snapshot=()=>Effect.succeed({tip:10,tipHash:"a".repeat(64),outputs:[]});
  await use(f,store=>Effect.gen(function*(){yield*setup(store);yield*invoice(store);}));
  const config={...f.config,database:join(f.root,"restored.db")};await Effect.runPromise(Effect.scoped(restoreApplication(config)));
  const script=`
    import {Effect} from "effect";
    import {SalesStore} from ${JSON.stringify(new URL("../../src/application/store.ts",import.meta.url).href)};
    import {DurableStore} from ${JSON.stringify(new URL("../../src/storage/store.ts",import.meta.url).href)};
    import {controllerFixture} from ${JSON.stringify(new URL("./reconciliation-fixture.ts",import.meta.url).href)};
    DurableStore.prototype.clearRestoreRequired=function(){process.kill(process.pid,"SIGKILL");};
    const config=JSON.parse(process.argv[1]),adapters={clock:()=>0,newDestination:Effect.die("no allocation"),
      snapshot:()=>Effect.succeed({tip:10,tipHash:"a".repeat(64),outputs:[]})};
    await Effect.runPromise(Effect.scoped(SalesStore.reconcileRecovery(config,adapters,controllerFixture().controller)));
  `;
  const child=spawnSync(process.execPath,["--input-type=module","-e",script,JSON.stringify(config)],{encoding:"utf8",timeout:10000});
  assert.equal(child.signal,"SIGKILL",child.stderr);
  const before=await recovered(config);assert.equal(before.status.restoreRequired,true);assert.equal(before.state.recovery!.required,false);
  await assert.rejects(Effect.runPromise(Effect.scoped(SalesStore.open(config,f.adapters))),/controller and chain reconciliation/);
  const result=await Effect.runPromise(Effect.scoped(SalesStore.reconcileRecovery(config,f.adapters,controllerFixture().controller)));
  assert.equal(result.ready,true);
  await use({...f,config},store=>Effect.gen(function*(){assert.equal((yield*store.operatorStatus()).paused,true);}));
  assert.equal(f.node.draws,1);
});
