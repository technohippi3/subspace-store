import json
import os
from pathlib import Path
import pwd
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from common import Refused
from recover import adopt_store,private_tree,reset_failed_secrets

class RecoveryOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup);self.root=Path(self.temporary.name)
        self.user=pwd.getpwnam('recovery')
    def test_recovery_resets_only_failed_credential_units_and_keeps_unloaded_oneshots_valid(self):
        selected={'secretsConfig':'/fixture/secrets.json'};value={'installation':'fixture'}
        with patch('recover.json_file',return_value={'roles':{'store':{},'maintenance':{}}}),patch('recover.command',side_effect=[b'inactive\n',b'failed\n',b'']) as execute:
            reset_failed_secrets(value,selected)
        self.assertEqual(execute.call_args_list[0].args[0],['/usr/bin/systemctl','show','subspace-secrets-fixture-store.service','--property=ActiveState','--value'])
        self.assertEqual(execute.call_args_list[2].args[0],['/usr/bin/systemctl','reset-failed','subspace-secrets-fixture-maintenance.service'])
        self.assertEqual(execute.call_count,3)
    def test_private_restored_tree_adopts_only_root_owned_private_regular_objects(self):
        data=self.root/'subs';data.mkdir(mode=0o700);(data/'state').write_bytes(b'fixture');(data/'state').chmod(0o600)
        outside=self.root/'core-wallet';outside.write_bytes(b'unchanged fixture');outside.chmod(0o600)
        private_tree(data,self.user.pw_uid,self.user.pw_gid)
        self.assertEqual((data/'state').stat().st_uid,self.user.pw_uid);self.assertEqual(data.stat().st_uid,self.user.pw_uid)
        self.assertEqual(outside.stat().st_uid,0);self.assertEqual(outside.read_bytes(),b'unchanged fixture')
    def test_links_and_foreign_owner_fail_before_any_adoption(self):
        for kind in ('symlink','hardlink','foreign'):
            with self.subTest(kind=kind):
                data=self.root/kind;data.mkdir(mode=0o700);first=data/'first';first.write_bytes(b'first');first.chmod(0o600)
                outside=self.root/(kind+'-outside');outside.write_bytes(b'outside');outside.chmod(0o600);bad=data/'bad'
                if kind=='symlink':bad.symlink_to(outside)
                elif kind=='hardlink':os.link(outside,bad)
                else:bad.write_bytes(b'foreign');bad.chmod(0o600);os.chown(bad,65534,65534)
                with self.assertRaises(Refused):private_tree(data,self.user.pw_uid,self.user.pw_gid)
                self.assertEqual(first.stat().st_uid,0);self.assertEqual(outside.stat().st_uid,0)
    def test_store_identity_and_exact_prefix_proof_precede_bounded_owner_adoption(self):
        app=self.root/'application';app.mkdir(mode=0o700);database=app/'store.db'
        identity={'version':1,'network':'main','wallet':'store','genesis':'a'*64,'descriptorHash':'b'*64}
        with sqlite3.connect(database) as db:
            db.execute('create table records(kind text,key text,value text)');db.execute('insert into records values(?,?,?)',('installation_identity','global',json.dumps(identity)))
        database.chmod(0o600)
        runtime={'version':2,'database':str(database),'network':'main','core':{'wallet':'store'},'installation':{'genesis':'a'*64,'descriptorHash':'b'*64}}
        file=self.root/'runtime.json';file.write_text(json.dumps(runtime));file.chmod(0o644)
        value={'storeConfig':str(file),'services':{'store':{'user':'recovery'}}}
        with patch('recover.store_prefix',side_effect=Refused('fixture-prefix-refused')):
            with self.assertRaises(Refused):adopt_store(value,Path('/release'))
        self.assertEqual(database.stat().st_uid,0)
        with patch('recover.store_prefix',return_value=0) as proof:adopt_store(value,Path('/release'));self.assertEqual(proof.call_count,1)
        self.assertEqual(database.stat().st_uid,self.user.pw_uid)

if __name__=='__main__':unittest.main()
