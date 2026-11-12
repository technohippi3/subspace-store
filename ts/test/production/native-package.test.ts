import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdtempSync, mkdirSync, rmSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execute=promisify(execFile), repository=process.env.SUBSPACE_PACKAGE_SOURCE_ROOT ?? fileURLToPath(new URL('../../../',import.meta.url));
const temporary=mkdtempSync(join(tmpdir(),'subspace-package-production-'));
process.once('exit',()=>rmSync(temporary,{recursive:true,force:true}));
const deployment=join(temporary,'deploy'), environment:NodeJS.ProcessEnv={...process.env,SUBSPACE_PACKAGE_APPLICATION_SOURCE:repository,
  SUBSPACE_PACKAGE_EVIDENCE_DIRECTORY:join(temporary,'evidence')};
// A nested Node test runner must execute its own files, not inherit the
// parent runner's internal child context and return without running them.
delete environment.NODE_TEST_CONTEXT;
async function run(binary:string,args:string[],cwd=deployment,timeout=600000){
  return execute(binary,args,{cwd,env:environment,timeout,maxBuffer:16*1024*1024});
}
async function nodeTests(file:string,minimum:number){
  const result=await run(process.execPath,['--test',join(deployment,file)]);
  const count=/\btests\s+([0-9]+)/.exec(result.stdout);
  if(!count||Number(count[1])<minimum)throw Error('nested production fixture did not execute its expected tests');
}
let prepared:Promise<void>|undefined;
function prepare(){return prepared??=(async()=>{
  mkdirSync(deployment);
  for(const name of ['native','client','recovery','alchemy','ssh-fixture','systemd-fixture','replay'])cpSync(join(repository,'deploy',name),join(deployment,name),
    {recursive:true,filter:path=>!path.split('/').some(part=>['node_modules','__pycache__','.alchemy','vm-cache','evidence'].includes(part))});
  await Promise.all([run('docker',['build','--tag','subspace-recovery-ssh-fixture:20261112',join(deployment,'ssh-fixture')]),
    run('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],join(deployment,'alchemy'))]);
})();}
let platform:Promise<void>|undefined;
function qualifyPlatform(){return platform??=(async()=>{
  await prepare();
  const image=process.env.SUBSPACE_PACKAGE_VM_IMAGE ?? join(temporary,'ubuntu-24.04-minimal-cloudimg-amd64.img');
  await run('python3',[join(deployment,'systemd-fixture/fetch-vm.py'),'--output',image]);
  let accelerator=process.env.SUBSPACE_PACKAGE_VM_ACCELERATOR;
  if(!accelerator){try{accessSync('/dev/kvm',constants.R_OK|constants.W_OK);accelerator='kvm';}catch{accelerator='tcg';}}
  Object.assign(environment,{SUBSPACE_PACKAGE_VM_IMAGE:image,SUBSPACE_PACKAGE_VM_ACCELERATOR:accelerator});
  await run('python3',['-m','unittest','test_package','-v'],join(deployment,'systemd-fixture'),900000);
})();}
let release:Promise<void>|undefined;
function qualifyRelease(){return release??=(async()=>{await prepare();await run('python3',['-m','unittest','test_release','test_source_provenance','-v'],join(deployment,'native'));})();}
let ssh:Promise<void>|undefined;
function qualifySsh(){return ssh??=(async()=>{await prepare();await nodeTests('client/test-ssh.mjs',1);})();}
let backend:Promise<void>|undefined;
function qualifyBackend(){return backend??=(async()=>{
  await prepare();await run('python3',['-m','unittest','test_helper','-v'],join(deployment,'recovery'));
  await nodeTests('client/test-client.mjs',8);
})();}
// Shared workers execute their real assertions once in this test process.
// No stored receipt is accepted as a substitute for any execution below.
test('O140: signed native release rejects corruption and an untrusted signer',async()=>{await qualifyRelease();});
test('O141: native install and idempotence use the same artifact as Alchemy',async()=>{await qualifyPlatform();});
test('O142: native update blocks live holds and preserves recorded address and review history',async()=>{
  await prepare();await run('python3',['-m','unittest','test_preflight','-v'],join(deployment,'native'));await qualifyPlatform();
});
test('O143: real systemd failed update leaves raw starts fenced and paused',async()=>{await qualifyPlatform();});
test('O144: actual controller snapshot excludes a competing systemd restart through encrypted remote acknowledgment',async()=>{await qualifyPlatform();});
test('O145: exact scoped host secret retrieval refuses stale fallback and selects attended values explicitly',async()=>{
  await prepare();await run('python3',['-m','unittest','test_secrets','-v'],join(deployment,'native'));await qualifyPlatform();
});
test('O146: pinned SSH and actual Alchemy removal preserve the existing host',async()=>{await qualifySsh();await qualifyPlatform();});
test('O147: immutable encrypted journals and snapshots acknowledge only bounded durable exact bytes',async()=>{await qualifyBackend();});
test('O148: actual SSH restores encrypted history after fixture seller deletion and refuses an outage',async()=>{await qualifySsh();});
test('O149: actual current application restores ten thousand validated orders over encrypted SSH within one minute',async()=>{
  await prepare();await run('python3',[join(deployment,'replay/replay.py'),'--source-root',repository],deployment,600000);
});
test('O150: signed rollback and explicit reviewed admission state survive native maintenance',async()=>{
  await qualifyRelease();await prepare();await run('docker',['run','--rm','--network','none','--mount',
    'type=bind,source='+join(deployment,'native')+',target=/code,readonly','--workdir','/code','subspace-recovery-ssh-fixture:20261112',
    'python3','-m','unittest','test_profile','test_recover','-v']);await qualifyPlatform();
});
