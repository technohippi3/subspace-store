import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from common import Refused, config
from profile import generate, PROFILE
from maintenance_view import maintenance_view
from checkpoint import controller_prefix
from installer import resume_admission

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
        db=sqlite3.connect(':memory:');self.addCleanup(db.close);db.execute('create table batches(bid text,members text,state text)')
        db.execute('insert into batches values(?,?,?)',('b1','[]','proved'))
        value={'seq':1,'kind':'batch','batch':{'bid':'b1','members':[],'state':'proved'}};raw=json.dumps(value).encode()
        page={'head':1,'entries':[{'sequence':1,'data':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()}]}
        with patch('checkpoint.recovery',return_value=page):self.assertEqual(controller_prefix(db,{},Path('/release')),1)
        db.execute("update batches set state='checkpointed'")
        with patch('checkpoint.recovery',return_value=page):
            with self.assertRaises(Refused):controller_prefix(db,{},Path('/release'))
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
