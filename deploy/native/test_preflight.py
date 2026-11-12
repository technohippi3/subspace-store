"""Readiness response composition; actual native-node qualification is separate."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from common import Refused

class PreflightTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);self.root=Path(temporary.name)
        spec=importlib.util.spec_from_file_location("checked_preflight",Path(__file__).with_name("host-preflight.py"))
        self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        (self.root/"native").mkdir();(self.root/"bin").mkdir()
        binary=self.root/"bin/node";binary.write_bytes(b"fixture-native-bytes")
        profile={"artifacts":{"node":{"path":"bin/node","sha256":hashlib.sha256(binary.read_bytes()).hexdigest()}}}
        self.put("native-artifacts.json",profile)
        descriptor="tr(fixture-public-expression/*)#fixture"
        self.put("store.json",{"version":2,"network":"regtest","core":{"url":"http://127.0.0.1:1","cookiePath":"/fixture/core.cookie","wallet":"store"},
            "installation":{"genesis":"g"*64,"descriptorHash":hashlib.sha256(json.dumps([descriptor],separators=(",",":")).encode()).hexdigest()}})
        self.put("runner.json",{"spaced":{"url":"http://127.0.0.1:2","cookie_file":"/fixture/spaced.cookie"},"controller":{"operator_wallet":"operator"}})
        self.value={"storeConfig":str(self.root/"store.json"),"runnerConfig":str(self.root/"runner.json"),"network":"regtest"}
        self.responses={"getblockchaininfo":{"chain":"regtest","blocks":100,"headers":100,"bestblockhash":"a"*64,"initialblockdownload":False},
            "getnetworkinfo":{"version":310200},"getmempoolinfo":{"loaded":True},"getblockhash":"g"*64,
            "getwalletinfo":{"walletname":"store","descriptors":True,"private_keys_enabled":True,"scanning":False,"lastprocessedblock":{"height":100,"hash":"a"*64}},
            "listdescriptors":{"wallet_name":"store","descriptors":[{"desc":descriptor}]},
            "getserverinfo":{"network":"regtest","tip":{"height":100,"hash":"a"*64}},
            "getblockheader":{"height":100,"hash":"a"*64,"confirmations":1},"walletgetinfo":{"tip":100}}
    def put(self,name,value):
        p=self.root/name;p.write_text(json.dumps(value));p.chmod(0o644)
    def run_preflight(self,change_tip=False):
        calls=[]
        def rpc(_url,_cookie,method,*unused,**keywords):
            calls.append(method)
            value=self.responses[method]
            if change_tip and method=="getblockchaininfo" and calls.count(method)>1:return {**value,"bestblockhash":"b"*64}
            return value
        with patch.object(self.module,"__file__",str(self.root/"native/host-preflight.py")),patch.object(self.module,"rpc",side_effect=rpc),patch.object(self.module,"command",side_effect=lambda args:b"v24.14.0" if args[0].endswith("/bin/node") else b"OpenSSL 3.0.0"):
            result=self.module.preflight(self.value)
        return result,calls
    def test_coherent_current_native_wallet_tips_pass_using_only_read_calls(self):
        result,calls=self.run_preflight();self.assertTrue(result["ready"])
        self.assertEqual(calls.count("getblockchaininfo"),2)
        self.assertFalse(any(name.startswith(("send","sign","create","import","getnewaddress")) for name in calls))
    def test_stale_headers_payment_wallet_spaced_and_operator_wallet_refuse(self):
        for method,key,value in [("getblockchaininfo","headers",101),("getmempoolinfo","loaded",False),
            ("getwalletinfo","lastprocessedblock",{"height":99,"hash":"b"*64}),
            ("getserverinfo","tip",{"height":99,"hash":"b"*64}),("walletgetinfo","tip",99)]:
            with self.subTest(method=method):
                old=self.responses[method][key];self.responses[method][key]=value
                try:
                    with self.assertRaises(Refused):self.run_preflight()
                finally:self.responses[method][key]=old
    def test_tip_change_during_readiness_refuses(self):
        with self.assertRaises(Refused):self.run_preflight(change_tip=True)

if __name__=="__main__":unittest.main()
