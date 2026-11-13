"""Installed v2 application with recorded upstream facts, never real funds."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time
import unittest

from fixtures import DRAFT, HERE, Hosts, port, write
sys.path.insert(0, str(DRAFT/'native'))
from profile import generate


class ApplicationPackageTests(unittest.TestCase):
    def setUp(self):
        # Final qualification must exercise the exact signed lifecycle/client
        # sources. The earlier preliminary run is retained as draft evidence.
        self.bootstrap_hashes={p.relative_to(DRAFT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
          for directory in ('native','client','recovery') for p in sorted((DRAFT/directory).iterdir())
          if p.is_file() and not p.name.startswith('test') and p.suffix in ('.py','.mjs')}
        for key in ('SUBSPACE_PACKAGE_RELEASE_V1','SUBSPACE_PACKAGE_RELEASE_V2'):
            release_manifest=json.loads(Path(os.environ[key]+'.manifest.json').read_bytes())
            self.assertEqual({name:release_manifest['files'][name]['sha256'] for name in self.bootstrap_hashes},self.bootstrap_hashes)
        self.host=Hosts();self.addCleanup(self.host.close);h=self.host
        self.etc='/etc/subspace-store/fixture';self.base='/srv/subspace-store/fixture'
        self.current='/opt/subspace-store/fixture/current';self.config=self.etc+'/installation.json'
        self.core_port=port();self.genesis='0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
        self.tip='a'*64;self.descriptor='tr('+('b'*64)+')#fixture'
        p=json.loads((DRAFT/'native/profile-input.example.json').read_text())
        p.update(installation='fixture',network='regtest',publicOrigin=f'https://store.fixture.test:{h.tls_port}',tlsCAFile='/etc/subspace-store/fixture-ca.pem',
          core={'url':f'http://127.0.0.1:{self.core_port}','cookiePath':'/fixture/core.cookie','wallet':'store','genesis':self.genesis,
                'descriptorHash':hashlib.sha256(json.dumps([self.descriptor],separators=(',',':')).encode()).hexdigest()},
          spaced={'url':f'http://127.0.0.1:{self.core_port}','cookiePath':'/fixture/core.cookie','operatorWallet':'operator','space':'space'},
          proverUrl='http://127.0.0.1:18111',relayUrl='http://127.0.0.1:18112',
          ports={'buyer':h.buyer_port,'operator':h.operator_port,'registry':port(),'subs':h.subs_port,'https':h.tls_port},
          limits={'windowSeconds':3600,'maximumRequests':120,'maximumOrders':10000},minimumFeeRateSatVb=2,maximumFeeRateSatVb=20,riskBudgetSats=100000,
          refundPolicy={'minimumRate':1000,'maximumRate':100000,'fallbackRate':2000,'buyerFeeCeiling':300,'confirmationTarget':6,'maximumFee':10000,'maximumRefund':100000},
          merchantDestinations=[],certificateTTLSeconds=3600,
          recovery={'host':h.bridge_address,'port':h.recovery_port,'user':'recovery','knownHostsFile':self.etc+'/recovery-known-hosts'},
          secrets={'endpoint':f'https://{h.bridge_address}:{h.api.server_port}','projectId':'fixture-project','environment':'fixture','path':'/installation','caFile':'/etc/subspace-store/fixture-ca.pem'})
        src=h.root/'profile-input.json';write(src,p,0o600);generated=h.root/'generated';generate(src,generated)
        installation=json.loads((generated/'installation.json').read_bytes())
        # The app, backend, native preflight, maintenance and HTTPS are shipped.
        # Upstream RPC/subs state is the explicitly recorded component boundary.
        installation['services']['subs']['command']=['/usr/bin/python3','/fixture/recorded-nodes.py','--config','/fixture/nodes.json','subs']
        write(generated/'installation.json',installation)
        h.exec('mkdir','-p',self.etc,'/fixture',self.base+'/onboarding')
        for file in generated.iterdir():h.copy(file,self.etc+'/'+file.name)
        h.put(self.etc+'/recovery-known-hosts',h.known)
        trust=Path(os.environ['SUBSPACE_PACKAGE_RELEASE_TRUST']);h.copy(trust,self.etc+'/release-trust.pem')
        h.put('/fixture/core.cookie','fixture:recorded-only-credential',0o600)
        h.copy(HERE/'recorded-nodes.py','/fixture/recorded-nodes.py')
        h.put('/fixture/state.json',{'coreAvailable':True})
        nodes={'corePort':self.core_port,'subsPort':h.subs_port,'coreCookie':'/fixture/core.cookie','coreNetwork':'regtest','spacesNetwork':'regtest',
          'paymentWallet':'store','operatorWallet':'operator','genesis':self.genesis,'tipHash':self.tip,'publicDescriptor':self.descriptor,
          'paymentScript':'5120'+('2'*64),'stateFile':'/fixture/state.json','callsFile':'/fixture/rpc-calls.json','subsDirectory':self.base+'/subs',
          'registryUrl':f'http://127.0.0.1:{p["ports"]["registry"]}'}
        h.put('/fixture/nodes.json',nodes)
        h.put('/usr/lib/systemd/system/fixture-recorded-core.service','[Service]\nExecStart=/usr/bin/python3 /fixture/recorded-nodes.py --config /fixture/nodes.json core\n')
        h.exec('systemctl','daemon-reload');h.exec('systemctl','start','fixture-recorded-core.service')
        files={'core-wallet.backup':b'recorded original Core backup','spaced-wallet.export':b'recorded original spaced export'}
        for name,data in files.items():h.put(self.base+'/onboarding/'+name,data,0o600)
        h.put(self.base+'/onboarding/manifest.json',{'label':'onboarding','store_journal':0,'controller_journal':0,
          'files':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()}},0o600)
        self.releases=[]
        self.release_inputs=[]
        for key in ('SUBSPACE_PACKAGE_RELEASE_V1','SUBSPACE_PACKAGE_RELEASE_V2'):
            prefix=Path(os.environ[key]);name=prefix.name;self.releases.append(name)
            manifest_file=Path(str(prefix)+'.manifest.json');manifest=json.loads(manifest_file.read_bytes())
            self.release_inputs.append({'release':name,'sourceCommit':manifest['sourceCommit'],
              'manifestSha256':hashlib.sha256(manifest_file.read_bytes()).hexdigest(),'artifactSha256':manifest['artifact']['sha256'],
              'schemas':manifest['schemas'],'trustKeySha256':hashlib.sha256(trust.read_bytes()).hexdigest()})
            h.exec('mkdir','-p','/incoming/'+name)
            for suffix,out in [('manifest.json','manifest.json'),('manifest.sig','manifest.sig'),('tar.gz','release.tar.gz')]:
                h.copy(Path(str(prefix)+'.'+suffix),'/incoming/'+name+'/'+out)

    def invoke(self,*arguments,success=True,timeout=180):
        h=self.host
        r=h.exec('/usr/bin/python3','/bootstrap/native/installer.py','--config',self.config,*arguments,success=False,timeout=timeout)
        if success and r.returncode:
            evidence=h.exec('journalctl','--no-pager','-n','100','--unit=subspace-*','--unit=fixture-recorded-core.service',success=False)
            raise AssertionError(r.stdout.decode()+r.stderr.decode()+evidence.stdout.decode(errors='replace'))
        return json.loads(r.stdout),r.returncode

    def install(self,name,success=True):
        root='/incoming/'+name
        return self.invoke('apply','--manifest',root+'/manifest.json','--signature',root+'/manifest.sig','--artifact',root+'/release.tar.gz',success=success)

    def status(self):
        code="import json,sys;sys.path.insert(0,'/bootstrap/native');from common import config;from host import operator;print(json.dumps(operator(config(sys.argv[1]),'/operator/status')))"
        return json.loads(self.host.exec('/usr/bin/python3','-c',code,self.config).stdout)

    def seller(self,*arguments):
        return json.loads(self.host.exec('/usr/bin/python3',self.current+'/native/seller.py','--config',self.config,*arguments,timeout=60).stdout)

    def buyer(self,method,path,body=None):
        code="import json,sys,urllib.request;req=urllib.request.Request(sys.argv[1],data=None if sys.argv[3]=='null' else sys.argv[3].encode(),headers={'Content-Type':'application/json'},method=sys.argv[2]);r=urllib.request.urlopen(req,timeout=30);print(r.read().decode())"
        return json.loads(self.host.exec('/usr/bin/python3','-c',code,f'http://127.0.0.1:{self.host.buyer_port}'+path,method,json.dumps(body),timeout=40).stdout)

    def test_actual_v2_bootstrap_update_and_installed_recovery(self):
        began=time.monotonic();h=self.host;first,_=self.install(self.releases[0])
        self.assertTrue(first['ready']);self.assertTrue(first['paused']);self.assertFalse(first['productionReady']);self.assertTrue(first['waitingSellerSetup'])
        status=self.status();self.assertTrue(status['paused']);self.assertTrue(status['acknowledged'])
        self.assertFalse(status['seller']['explicit_limits']);self.assertEqual(status['seller']['spaces'],[])
        self.assertEqual(json.loads(h.exec('cat','/fixture/rpc-calls.json').stdout).get('getnewaddress',0),0)
        # Explicit fixture commercial inputs use the shipped preview/apply CLI.
        self.seller('space','add','space','--apply')
        self.assertEqual(json.loads(h.exec('cat','/fixture/rpc-calls.json').stdout).get('getnewaddress',0),0)
        self.seller('admission','set','3600','120','10000','--apply');self.seller('name','list','n0@space','1000','--apply');self.seller('resume','--apply')
        link=self.buyer('POST','/requests',{'handle':'n0@space','script_pubkey':'5120'+'1'.zfill(64)})['order_link']
        invoice=self.buyer('POST',link+'/quote',{});self.assertTrue(invoice['payment_request_open']);self.assertIsNotNone(invoice['address'])
        held_until=invoice['hold_expires_at'];blocked,code=self.install(self.releases[1],success=False)
        self.assertEqual(code,2);self.assertTrue(any(v['kind']=='active_hold' for v in blocked['blockers']))
        # An ordinary secret outage preserves the hold but closes the payment
        # prompt durably before any fresh same-database observation/listener.
        h.api_available=False
        result=h.exec('systemctl','restart','subspace-fixture-store.service',success=False);self.assertNotEqual(result.returncode,0)
        h.api_available=True;h.exec('systemctl','reset-failed','subspace-secrets-fixture-store.service');h.exec('systemctl','start','subspace-fixture-store.service')
        deadline=time.monotonic()+30
        while True:
            try:
                after=self.buyer('GET',link);break
            except Exception:
                self.assertLess(time.monotonic(),deadline);time.sleep(.1)
        self.assertEqual(after['payment_history'],'unknown');self.assertFalse(after['payment_request_open']);self.assertIsNone(after['address'])
        self.assertEqual(after['hold_expires_at'],held_until);self.assertTrue(self.status()['paused'])
        self.assertEqual(self.buyer('POST',link+'/cancel',{})['cancellation'],'final')
        updated,_=self.install(self.releases[1]);self.assertTrue(updated['paused']);self.assertTrue(updated['ready'])
        # Fresh host-secret outage must fail before a normal service listener.
        h.api_available=False
        result=h.exec('systemctl','restart','subspace-fixture-store.service',success=False)
        self.assertNotEqual(result.returncode,0);self.assertEqual(h.exec('systemctl','show','subspace-fixture-store.service','--property=MainPID','--value').stdout.strip(),b'0')
        h.api_available=True
        recovered,_=self.invoke('recover','--confirm','fixture',timeout=300)
        self.assertTrue(recovered['paused']);self.assertTrue(recovered['ready']);self.assertTrue(self.status()['paused'])
        self.assertGreaterEqual(self.status()['unknown_payment_history'],1)
        # Delete only disposable application/controller/subs state. The known
        # remote history and original fixture Core/spaced cookie stay intact.
        h.exec('systemctl','stop','subspace-fixture-proxy.service','subspace-fixture-store.service','subspace-fixture-subs.service')
        remove="from pathlib import Path;import shutil;root=Path('/srv/subspace-store/fixture');db=root/'store/store.db';[(p.unlink() if p.is_file() else None) for p in db.parent.iterdir() if p.name.startswith('store.db')];[(shutil.rmtree(p) if p.is_dir() else p.unlink()) for name in ('controller','subs') for p in (root/name).iterdir()]"
        h.exec('/usr/bin/python3','-c',remove)
        h.api_available=False;failed,code=self.invoke('recover','--confirm','fixture',success=False,timeout=300)
        self.assertEqual(code,2);self.assertTrue(failed['paused'])
        h.exec('test','-f',self.base+'/lifecycle/recovery.json');h.exec('test','!', '-e',self.base+'/store/store.db')
        before_calls=json.loads(h.exec('cat','/fixture/rpc-calls.json').stdout)
        raw=h.exec(self.current+'/bin/node',self.current+'/app/ts/src/main.ts',self.etc+'/store.json',success=False)
        self.assertNotEqual(raw.returncode,0);h.exec('test','!', '-e',self.base+'/store/store.db')
        self.assertEqual(json.loads(h.exec('cat','/fixture/rpc-calls.json').stdout),before_calls)
        role_map=json.loads(h.exec('cat',self.etc+'/secrets.json').stdout)['roles']
        for role,names in role_map.items():
            directory='/run/subspace-store-fixture/attended/'+role;h.exec('mkdir','-p',directory);h.exec('chmod','0700',directory)
            for name in names:h.put(directory+'/'+name,h.values[name],0o600)
        attended,_=self.invoke('recover','--confirm','fixture','--attended-credentials',timeout=300)
        self.assertTrue(attended['paused']);self.assertTrue(attended['ready']);self.assertEqual(attended['credentialSource'],'attended')
        restored=self.buyer('GET',link);self.assertEqual(restored['payment_history'],'unknown');self.assertFalse(restored['payment_request_open']);self.assertIsNone(restored['address'])
        # The next normal start still selects Infisical and cannot silently
        # reuse this explicitly attended attempt's values.
        again=h.exec('systemctl','restart','subspace-fixture-store.service',success=False);self.assertNotEqual(again.returncode,0)
        self.assertEqual(h.exec('systemctl','show','subspace-fixture-store.service','--property=MainPID','--value').stdout.strip(),b'0')
        calls=json.loads(h.exec('cat','/fixture/rpc-calls.json').stdout)
        self.assertEqual(calls.get('getnewaddress',0),1)
        self.assertFalse(set(calls)&{'createwallet','importdescriptors','walletpassphrase','signrawtransactionwithwallet','sendrawtransaction'})
        evidence={'scope':'actual v2 TS application, remote adapters, installer, systemd255 credentials and HTTPS; Core/spaced/subs RPCs recorded, no financial qualification',
          'releaseInputs':self.release_inputs,'configurationOverrides':['subs service uses explicitly recorded upstream fixture'],
          'bootstrapCodeHashes':self.bootstrap_hashes,
          'release':self.releases[1],'elapsedSeconds':round(time.monotonic()-began,3),'pausedBootstrap':True,'unconfiguredSeller':True,
          'secretOutageRefused':True,'installedRecoveryPaused':True,'remoteHostLossRecovered':True,'explicitAttendedRecovery':True,
          'noAutomaticAttendedFallback':True,'startupUnknownClosedPrompt':True,'holdUnchanged':True,'activeHoldUpdateRefused':True,'rpcMethodCounts':calls}
        output=Path(os.environ.get('SUBSPACE_PACKAGE_EVIDENCE_DIRECTORY',str(DRAFT/'evidence')));output.mkdir(exist_ok=True,parents=True)
        write(output/'actual-v2-installed-application.json',evidence);print(json.dumps(evidence))

if __name__=='__main__':unittest.main()
