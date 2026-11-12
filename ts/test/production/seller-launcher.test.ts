import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { startRuntime } from "../../src/runtime/server.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { script } from "./application-fixture.ts";

test("K34: shipped seller CLI uses installed configuration and private exclusive operation files without wallet setup or bearer output",async(t)=>{
  const f=await runtimeFixture(t),configuration=join(f.root,"runtime.json"),nomination=join(f.root,"request.json");
  await writeFile(configuration,JSON.stringify(f.config));await writeFile(nomination,JSON.stringify({handle:"n0@space",script_pubkey:script}));
  const main=fileURLToPath(new URL("../../src/seller.ts",import.meta.url)),execute=promisify(execFile);
  const cli=(...args:string[])=>execute(process.execPath,[main,configuration,...args],{timeout:15000,maxBuffer:1_000_000});
  await Effect.runPromise(Effect.scoped(Effect.gen(function*(){const runtime=yield* startRuntime(f.config);
    yield* Effect.promise(async()=>{
      await cli("space","add","space","--apply");await cli("name","list","n0@space","1000","--apply");
      await cli("admission","set","600","10","100","--apply");await cli("resume","--apply");await cli("name","reserve","n0@space","--apply");
      const path=join(f.root,"owner-private.json"),retry=join(f.root,"owner-retry.json");
      const result=await cli("owner","invoice",nomination,"--operation","a".repeat(32),"--confirm","n0@space","--save-link",path,"--apply");
      const saved=JSON.parse(await readFile(path,"utf8")) as {order:string;order_link:string;request:unknown};
      assert.equal((await stat(path)).mode&0o777,0o600);assert.match(saved.order_link,/^\/o\/[A-Za-z0-9_-]{32}$/);
      assert.equal(result.stdout.includes(saved.order_link),false);assert.equal((await fetch(runtime.buyer+saved.order_link)).status,200);
      const before=await readFile(path,"utf8");const repeated=await cli("owner","retry",path,"--save-link",retry,"--apply");
      assert.equal((JSON.parse(repeated.stdout) as {created:boolean}).created,false);assert.equal(await readFile(path,"utf8"),before);
      assert.equal((JSON.parse(await readFile(retry,"utf8")) as {order_link:unknown}).order_link,null);
      await assert.rejects(()=>cli("owner","invoice",nomination,"--operation","b".repeat(32),"--confirm","n0@space","--save-link",path,"--apply"));
      const orders=await f.api(runtime.operator,"/operator/orders",f.operator);assert.deepEqual(orders.value.orders,["o1"]);
      const status=await cli("diagnose");assert.equal(status.stdout.includes(saved.order_link),false);
      const malformed=join(f.root,"bad-request.json");await writeFile(malformed,'{"handle":"n0@space","handle":"n1@space","script_pubkey":"'+script+'"}');
      await assert.rejects(()=>cli("owner","invoice",malformed,"--operation","c".repeat(32),"--confirm","n1@space","--save-link",join(f.root,"bad-record"),"--apply"));
    });
  })));
});
