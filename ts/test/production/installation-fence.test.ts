import {test} from "node:test";
import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";
import {once} from "node:events";
import {chmodSync, existsSync, symlinkSync, unlinkSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {Effect} from "effect";
import {ownInstallation} from "../../src/runtime/installation-fence.ts";
import {startRuntime} from "../../src/runtime/server.ts";
import {recoveryCommand} from "../../src/runtime/recovery.ts";
import {GENESIS, descriptorFingerprint} from "../../src/bitcoin/identity.ts";
import {runtimeFixture, until} from "./runtime-fixture.ts";
const repository=fileURLToPath(new URL("../../../",import.meta.url));
const python=promisify(execFile);
const scoped=<A,E>(work:Effect.Effect<A,E,import("effect").Scope.Scope>)=>Effect.runPromise(Effect.scoped(work));
const descriptors={descriptors:[{desc:"tr(mock-public-expression/*)#fixture"}]};
const fingerprint=descriptorFingerprint(descriptors);
test("O126: shared installation ownership survives flock helper exit and excludes an exclusive updater until all owners close",async(t)=>{
  const f=await runtimeFixture(t),lock=join(f.root,"maintenance.lock"),latch=join(f.root,"maintenance.json");writeFileSync(lock,"",{mode:0o644});
  const first=ownInstallation(lock,latch),second=ownInstallation(lock,latch);
  const exclusive=()=>python("python3",["-c","from controller.installation_fence import acquire;import os,sys;fd=acquire(sys.argv[1],exclusive=True);os.close(fd)",lock],{cwd:repository});
  try {await assert.rejects(exclusive());first();await assert.rejects(exclusive());}finally{first();second();}
  await exclusive();
  await python("python3",["-c","from controller.installation_fence import configured;import os,sys;fd=configured({'version':2,'maintenance_lock':sys.argv[1]});os.close(fd)",lock],{cwd:repository});
});
test("O127: exclusive maintenance fences raw TypeScript serve and recovery plus raw Python runner controller and baseline store before work",async(t)=>{
  const f=await runtimeFixture(t),maintenanceLock=join(f.root,"maintenance.lock");writeFileSync(maintenanceLock,"",{mode:0o644});f.state.chain="main";
  const child=spawn("python3",["-c","from controller.installation_fence import acquire;import sys;fd=acquire(sys.argv[1],exclusive=True);print('locked',flush=True);sys.stdin.read()",maintenanceLock],{cwd:repository,stdio:["pipe","pipe","pipe"]});
  let output="";child.stdout.on("data",data=>{output+=String(data);});
  try {
    await until(async()=>assert.match(output,/locked/));
    const config={...f.config,version:2 as const,network:"main" as const,maintenanceLock,installation:{genesis:GENESIS.main,descriptorHash:fingerprint}};
    await assert.rejects(scoped(startRuntime(config)),/installation maintenance/);
    for(const mode of ["restore","recover","reconcile"] as const)await assert.rejects(scoped(recoveryCommand(mode,config,"unused")),/installation maintenance/);
    assert.equal(f.calls.length,0);assert.equal(existsSync(f.config.database),false);
    const script=`from tests.test_controller_host import config
from controller import host
from runner import cli
from service import __main__ as service
from controller.installation_fence import InstallationBusy
from unittest.mock import patch
import sys
c=config(sys.argv[2],write=False);c.update(version=2,maintenance_lock=sys.argv[1])
for action in (lambda:cli.build(c),lambda:host.build(c,None),lambda:service.build(c),lambda:service.restore(c)):
    with patch('runner.store.configured_store') as store,patch('service.__main__.BitcoinRpc') as rpc:
        try: action()
        except InstallationBusy: pass
        else: raise AssertionError('maintenance was bypassed')
        assert not store.called and not rpc.called
`;
    await python("python3",["-c",script,maintenanceLock,f.root],{cwd:repository});
  } finally {if(child.exitCode===null){const done=once(child,"exit");child.stdin.end();await done;}}
});
test("O128: durable and dangling maintenance latches and unsafe ownership paths refuse both raw ownership helpers",async(t)=>{
  const f=await runtimeFixture(t),lock=join(f.root,"maintenance.lock"),latch=join(f.root,"maintenance.json");writeFileSync(lock,"",{mode:0o644});
  const refused=async()=>{assert.throws(()=>ownInstallation(lock,latch));await assert.rejects(python("python3",["-c","from controller.installation_fence import configured;import sys;configured({'version':2,'maintenance_lock':sys.argv[1]})",lock],{cwd:repository}));};
  writeFileSync(latch,"{}",{mode:0o600});await refused();unlinkSync(latch);
  symlinkSync(join(f.root,"absent-latch-target"),latch);await refused();unlinkSync(latch);
  chmodSync(lock,0o666);await refused();chmodSync(lock,0o644);
  unlinkSync(lock);symlinkSync(join(f.root,"absent-lock-target"),lock);await refused();
});
