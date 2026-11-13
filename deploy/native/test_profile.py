import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from common import Refused, config
from profile import generate, PROFILE
from maintenance_view import maintenance_view
from checkpoint import controller_prefix, controller_record
from installer import resume_admission
from units import shared_lock

class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup);self.root=Path(self.temporary.name)
        self.input={'profile':PROFILE,'installation':'fixture','network':'regtest','publicOrigin':'https://store.fixture.test',
          'tlsCAFile':'/etc/subspace-store/ca.pem','core':{'url':'http://127.0.0.1:18443','cookiePath':'/native/core.cookie','wallet':'store',
            'genesis':'0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206','descriptorHash':'a'*64},
          'spaced':{'url':'http://127.0.0.1:7224','cookiePath':'/native/spaced.cookie','operatorWallet':'operator','space':'space'},
          'proverUrl':'http://127.0.0.1:18111','relayUrl':'http://127.0.0.1:18112','ports':{'buyer':18951,'operator':18952,'registry':18949,'subs':7777,'https':443},
          'limits':{'windowSeconds':3600,'maximumRequests':120,'maximumOrders':10000},'minimumFeeRateSatVb':2,'maximumFeeRateSatVb':20,'riskBudgetSats':100000,
          'refundPolicy':{'minimumRate':1000,'maximumRate':100000,'fallbackRate':2000,'buyerFeeCeiling':300,'confirmationTarget':6,'maximumFee':10000,'maximumRefund':100000},
          'merchantDestinations':[],'recovery':{'host':'recovery.fixture.test','port':22,'user':'recovery','knownHostsFile':'/etc/subspace-store/recovery-known-hosts'},
          'secrets':{'endpoint':'https://app.infisical.com','projectId':'fixture-project','environment':'fixture','path':'/installation','caFile':'/etc/ssl/certs/ca-certificates.crt'},'certificateTTLSeconds':3600}
    def make(self):
        p=self.root/'input.json';p.write_text(json.dumps(self.input));p.chmod(0o600)
        out=self.root/'generated';generate(p,out);return out
    def test_generated_public_configuration_ignores_restrictive_umask(self):
        previous=os.umask(0o077)
        try:out=self.make()
        finally:os.umask(previous)
        self.assertEqual(out.stat().st_mode & 0o777,0o755)
        for name in ('installation','store','runner','secrets','recovery-store','recovery-maintenance'):
            self.assertEqual((out/(name+'.json')).stat().st_mode & 0o777,0o644)
        self.assertEqual((self.root/'input.json').stat().st_mode & 0o777,0o600)
    def test_shared_lifecycle_lock_normalizes_only_safe_regular_root_files(self):
        safe=self.root/'safe.lock';safe.write_bytes(b'');safe.chmod(0o600)
        shared_lock(safe)
        self.assertEqual(safe.stat().st_mode & 0o777,0o644)
        for kind in ('hardlink','writable','foreign','fifo','symlink'):
            path=self.root/(kind+'.lock')
            if kind=='hardlink':os.link(safe,path)
            elif kind=='fifo':os.mkfifo(path,0o600)
            elif kind=='symlink':path.symlink_to(safe)
            else:
                path.write_bytes(b'private fixture');path.chmod(0o666 if kind=='writable' else 0o600)
                if kind=='foreign':os.chown(path,65534,65534)
            before=path.lstat().st_mode
            with self.assertRaises((Refused,OSError)):shared_lock(path)
            self.assertEqual(path.lstat().st_mode,before)
            path.unlink()
    def test_explicit_profile_has_shipped_commands_remote_only_refs_and_trusted_export_origin(self):
        out=self.make();host=config(out/'installation.json');runtime=json.loads((out/'store.json').read_text());runner=json.loads((out/'runner.json').read_text())
        self.assertEqual(runtime['certificateExport']['trustedOrigin'],host['publicOrigin'])
        self.assertEqual(set(runtime['recoveryBackend']),{'version','node','client','config'})
        self.assertEqual(set(runner['recovery_backend']),{'version','node','client','config'})
        self.assertIn('externalCredentials',host['services']['store'])
        self.assertIn('subs-fence.py',runner['subs']['stop_command'][1])
        self.assertEqual(host['commands']['reconcile'][1],'${RELEASE}/native/reconcile.py')
        with self.assertRaises(Refused):generate(self.root/'input.json',out)
    def test_unqualified_capacity_and_missing_explicit_fields_refuse(self):
        self.input['limits']['maximumOrders']=10001
        with self.assertRaises(Refused):self.make()
    def test_inline_recovery_credentials_and_malformed_references_refuse_before_output(self):
        original=dict(self.input['recovery'])
        for changed in (dict(original,password='fixture-inline-value'),dict(original,privateKey='fixture-inline-value'),
                        dict(original,host='user:fixture-inline-value@host'),dict(original,user='-option'),
                        dict(original,port=True),dict(original,knownHostsFile='relative')):
            with self.subTest(keys=sorted(changed)):
                self.input['recovery']=changed
                with self.assertRaises(Refused):self.make()
                self.assertFalse((self.root/'generated').exists())
    def test_owner_review_after_tenth_conversion_is_preserved_but_new_threshold_crossing_stays_paused(self):
        self.assertTrue(resume_admission({'priorPaused':False,'reviewCount':10},{'reviewCount':10},0))
        self.assertFalse(resume_admission({'priorPaused':False,'reviewCount':9},{'reviewCount':10},0))
        self.assertFalse(resume_admission({'priorPaused':True,'reviewCount':10},{'reviewCount':10},0))
        self.assertFalse(resume_admission({'priorPaused':False,'reviewCount':10},{'reviewCount':10},1))
        self.assertFalse(resume_admission({'priorPaused':False,'reviewCount':10},{'reviewCount':10,'productionReady':False},0))
    def test_offline_view_uses_fresh_own_refs_and_bounded_cookies_and_cleans_up(self):
        out=self.make();host=config(out/'installation.json')
        host['storeConfig']=str(out/'store.json');host['runnerConfig']=str(out/'runner.json');host['secretsConfig']=str(out/'secrets.json')
        host['recoveryConfig']=str(out/'recovery-maintenance.json');host['runtimeDirectory']=str(self.root/'run')
        for name in ('core','spaced'):
            p=self.root/(name+'.cookie');p.write_bytes(b'fixture:credential');p.chmod(0o600);host['nativeRpc'][name]['cookiePath']=str(p)
        with maintenance_view(host,Path('/release')) as (store_file,runner_file):
            s=json.loads(store_file.read_text());r=json.loads(runner_file.read_text());self.assertEqual(s['recoveryBackend'],r['recovery_backend'])
            self.assertNotIn('/run/credentials/',s['core']['cookiePath']);self.assertEqual(Path(s['core']['cookiePath']).read_bytes(),b'fixture:credential')
            directory=store_file.parent
        self.assertFalse(directory.exists())
    def test_controller_checkpoint_validates_decrypted_prefix_and_latest_database_state(self):
        release=self.root/'release'
        db=sqlite3.connect(':memory:');self.addCleanup(db.close);db.execute('create table batches(bid text,members text,state text)')
        db.execute('insert into batches values(?,?,?)',('b1','[]','proved'))
        value={'seq':1,'kind':'batch','batch':{'bid':'b1','members':[],'state':'proved'}};raw=json.dumps(value).encode()
        page={'head':1,'entries':[{'sequence':1,'data':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()}]}
        with patch('checkpoint.recovery',return_value=page):self.assertEqual(controller_prefix(db,{},release),1)
        frame=b'SSCJ3 {"kind":"controller_protocol","requires":["preparation_abort_v1"],"seq":2,"version":3}'
        def item(raw,sequence):return {'sequence':sequence,'data':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()}
        first={'head':2,'entries':page['entries']};second={'head':2,'entries':[item(frame,2)]}
        with patch('checkpoint.recovery',side_effect=[first,second]):self.assertEqual(controller_prefix(db,{},release),2)
        for fault in ('version','feature','duplicate','unframed','digest','sequence','gap','changed-head','incomplete','past-head','count','page-bytes'):
            with self.subTest(fault=fault):
                tail=json.loads(json.dumps(second))
                raw=frame
                if fault=='version':raw=frame.replace(b'"version":3',b'"version":4')
                elif fault=='feature':raw=frame.replace(b'preparation_abort_v1',b'unknown')
                elif fault=='duplicate':raw=frame[:-1]+b',"version":3}'
                elif fault=='unframed':raw=frame[6:]
                elif fault=='sequence':raw=frame.replace(b'"seq":2',b'"seq":3')
                elif fault=='page-bytes':raw=b' '*(16*1024*1024)+frame
                tail['entries']=[item(raw,2)]
                if fault=='digest':tail['entries'][0]['sha256']='0'*64
                elif fault=='gap':tail['entries'][0]['sequence']=3
                elif fault=='changed-head':tail['head']=3
                elif fault=='incomplete':tail['entries']=[]
                elif fault=='past-head':tail['entries'].append(item(b'{"kind":"diagnostic","seq":3}',3))
                elif fault=='count':tail['entries']*=8193
                with patch('checkpoint.recovery',side_effect=[first,tail]):
                    with self.assertRaises((Refused,ValueError)):controller_prefix(db,{},release)
        db.execute("update batches set state='checkpointed'")
        with patch('checkpoint.recovery',return_value=page):
            with self.assertRaises(Refused):controller_prefix(db,{},release)
    def test_controller_checkpoint_never_executes_a_payload_codec(self):
        release=self.root/'release';codec=release/'app/controller/journal_protocol.py';codec.parent.mkdir(parents=True)
        marker=self.root/'payload-executed'
        codec.write_text('from pathlib import Path\nPath('+repr(str(marker))+').touch()\nraise RuntimeError("payload codec ran")\n')
        db=sqlite3.connect(':memory:');self.addCleanup(db.close);db.execute('create table batches(bid text,members text)')
        with patch('checkpoint.recovery',return_value={'head':0,'entries':[]}):
            self.assertEqual(controller_prefix(db,{},release),0)
        self.assertFalse(marker.exists())
    def test_bootstrap_and_controller_agree_on_mandatory_protocol_data(self):
        repository=Path(os.environ.get('SUBSPACE_PACKAGE_APPLICATION_SOURCE') or Path(__file__).resolve().parents[2])
        spec=importlib.util.spec_from_file_location('application_protocol',repository/'controller/journal_protocol.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        protocol={'seq':1,'kind':'controller_protocol','version':3,'requires':['preparation_abort_v1']}
        valid=[json.dumps({'seq':1,'kind':'diagnostic'}),'SSCJ3 '+json.dumps(protocol)]
        invalid=[json.dumps(protocol),'SSCJ3 []','SSCJ3 '+json.dumps(dict(protocol,seq=True)),
            'SSCJ3 '+json.dumps(dict(protocol,version=4)), 'SSCJ3 '+json.dumps(dict(protocol,requires=['unknown'])),
            'SSCJ3 '+json.dumps(dict(protocol,extra=True)), 'SSCJ3 '+json.dumps(protocol)[:-1]+',"version":3}']
        for raw in valid:self.assertEqual(controller_record(raw),module.decode_record(raw))
        for raw in invalid:
            with self.subTest(raw=raw):
                with self.assertRaises((Refused,ValueError)):controller_record(raw)
                with self.assertRaises(ValueError):module.decode_record(raw)
    def test_release_inventory_refuses_a_foreign_owned_signed_file(self):
        from release import verify_installed_release
        release=self.root/'release';release.mkdir();file=release/'application.txt';file.write_bytes(b'fixture');file.chmod(0o644)
        manifest={'files':{'application.txt':{'size':7,'sha256':hashlib.sha256(b'fixture').hexdigest(),'executable':False}}}
        verify_installed_release(release,manifest)
        os.chown(file,65534,65534)
        with self.assertRaises(Refused):verify_installed_release(release,manifest)
    def test_subs_configuration_disables_auto_publish_before_native_exec_and_preserves_other_values(self):
        spec=importlib.util.spec_from_file_location('subs_start',Path(__file__).with_name('subs-start.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        runtime=self.root/'store.json';runtime.write_text(json.dumps({'listen':{'subs':18949}}));runtime.chmod(0o644)
        data=self.root/'subs';data.mkdir();creds=self.root/'credentials';creds.mkdir();token=creds/'registry-token';token.write_bytes(b'fixture-token-32-bytes-credential-value');token.chmod(0o600)
        db=sqlite3.connect(data/'config.db');db.execute('create table config(key TEXT PRIMARY KEY,value TEXT NOT NULL)');db.executemany('insert into config values(?,?)',[('registry_auto_sync','1'),('retained-setting','retain')]);db.commit();db.close()
        module.prepare_config({'storeConfig':str(runtime),'proverUrl':'http://127.0.0.1:18111'},{'subs':{'data_dir':str(data)}},creds)
        with sqlite3.connect(data/'config.db') as db:
            values=dict(db.execute('select * from config'));self.assertEqual(values['registry_auto_sync'],'0');self.assertEqual(values['retained-setting'],'retain')
            db.execute('alter table config add column unsupported text')
        with self.assertRaises(Refused):module.prepare_config({'storeConfig':str(runtime),'proverUrl':'http://127.0.0.1:18111'},{'subs':{'data_dir':str(data)}},creds)

if __name__=='__main__':unittest.main()
