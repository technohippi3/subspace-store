import {test} from "node:test";
import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";
import {once} from "node:events";
import {chmodSync, existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync} from "node:fs";
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


test("O180: persistent recovery markers exclude raw ordinary writers while only the matching fixed read-only recovery paths retain shared ownership",async(t)=>{
  const f=await runtimeFixture(t),maintenanceLock=join(f.root,"maintenance.lock"),marker=join(f.root,"recovery.json");writeFileSync(maintenanceLock,"",{mode:0o644});
  const config={...f.config,version:2 as const,maintenanceLock,installation:{genesis:GENESIS.regtest,descriptorHash:fingerprint}};
  await scoped(startRuntime(config));const original=readFileSync(config.database);f.calls.length=0;
  writeFileSync(marker,JSON.stringify({version:1,applicationPath:repository.replace(/\/$/,"")}),{mode:0o600});
  await assert.rejects(scoped(startRuntime(config)),/installation maintenance/);assert.equal(f.calls.length,0);assert.deepEqual(readFileSync(config.database),original);
  for(const port of Object.values(config.listen))await assert.rejects(fetch(`http://127.0.0.1:${port}/operator/status`));
  const release=ownInstallation(maintenanceLock,join(f.root,"maintenance.json"),"recovery");
  try{await assert.rejects(python("python3",["-c","from controller.installation_fence import acquire;import sys;acquire(sys.argv[1],exclusive=True)",maintenanceLock],{cwd:repository}));}finally{release();}
  const restored={...config,database:join(f.root,"restored.db")};
  const receipt=await scoped(recoveryCommand("restore",restored));assert.equal(receipt.acknowledged,true);assert.equal(receipt.sales_paused,true);assert.equal(receipt.ready,false);assert.equal(f.calls.length,0);
  const script=`from tests.test_controller_host import config
from controller import host
from runner import cli
from runner.cli import Runner, NotConfirmed
from runner.recovery_bridge import RecoveryStore
from service import __main__ as service
from controller.installation_fence import InstallationBusy
from controller.errors import Refused
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import sys
c=config(sys.argv[2],write=False);c.update(version=2,maintenance_lock=sys.argv[1])
for action in (lambda:cli.build(c),lambda:host.build(c,None),lambda:host.build(c,SimpleNamespace(offline_recovery=True)),lambda:service.build(c),lambda:service.restore(c)):
    with patch('runner.store.configured_store') as store,patch('controller.host.Controller') as controller,patch('service.__main__.BitcoinRpc') as rpc:
        try: action()
        except InstallationBusy: pass
        else: raise AssertionError('ordinary writer bypassed recovery marker')
        assert not store.called and not controller.called and not rpc.called
registry=RecoveryStore(dict(version=1,store='fixture',sourceSequence=0,sequence=0,tipHeight=0,tipHash='a'*64,orders=[],entries=[],spaces=[]))
controller,publisher=host.build(c,registry)
try:
    try: Runner(registry,controller,recovery_only=True).issue('fixture',1,'fixture')
    except NotConfirmed as error: assert "offline recovery cannot" in str(error)
    else: raise AssertionError('offline recovery could send')
finally:
    publisher.db.close();controller.close()
`;
  await python("python3",["-c",script,maintenanceLock,f.root],{cwd:repository});
  for(const bytes of [JSON.stringify({version:1,applicationPath:join(f.root,"other-release")}),"{}","x".repeat(65537)]){
    writeFileSync(marker,bytes);await assert.rejects(scoped(recoveryCommand("restore",{...config,database:join(f.root,"must-not-create.db")})),/installation maintenance/);assert.equal(existsSync(join(f.root,"must-not-create.db")),false);
  }
  writeFileSync(marker,JSON.stringify({version:1,applicationPath:repository.replace(/\/$/,"")}));chmodSync(marker,0o644);
  await assert.rejects(scoped(recoveryCommand("restore",{...config,database:join(f.root,"must-not-create.db")})),/installation maintenance/);
  chmodSync(marker,0o600);unlinkSync(marker);symlinkSync(join(f.root,"absent-marker"),marker);
  await assert.rejects(scoped(startRuntime(config)),/installation maintenance/);await assert.rejects(scoped(recoveryCommand("restore",restored)),/installation maintenance/);
  unlinkSync(marker);
  await assert.rejects(scoped(startRuntime(config)),/requires controller and chain reconciliation/);assert(!f.calls.some(c=>/send|sign|newaddress/.test(c.method)));
});
