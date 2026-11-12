"""Actual package and systemd evidence with explicit fake app/node adapters."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import threading
import unittest

from fixtures import DRAFT, HERE, Hosts, run, write
sys.path.insert(0, str(DRAFT / "native"))
from release import build


class PackageTests(unittest.TestCase):
    def setUp(self):
        (DRAFT/'evidence').mkdir(exist_ok=True,mode=0o700)
        self.host = Hosts()
        self.addCleanup(self.host.close)
        host = self.host
        self.config = {"version": 1, "installation": "fixture", "baseDirectory": "/srv/subspace-store",
            "releaseDirectory": "/opt/subspace-store/releases", "currentPath": "/opt/subspace-store/current",
            "runtimeDirectory": "/run/subspace-store", "trustKey": "/etc/subspace-store/trust.pem",
            "storeConfig": "/etc/subspace-store/store.json", "runnerConfig": "/etc/subspace-store/runner.json",
            "secretsConfig": "/etc/subspace-store/secrets.json", "recoveryConfig": "/etc/subspace-store/recovery.json",
            "walletBackupDirectory": "/srv/subspace-store/onboarding", "network": "regtest", "minimumFreeBytes": 1024 * 1024,
            "publicOrigin": f"https://store.fixture.test:{host.tls_port}",
            "tls": {"certificateFile": "/run/subspace-secrets/proxy/tls-cert", "privateKeyFile": "/run/subspace-secrets/proxy/tls-key",
                    "caFile": "/etc/subspace-store/fixture-ca.pem", "listenPort": host.tls_port, "listenAddress": "127.0.0.1"},
            "services": {}, "commands": {}, "operator": {"url": f"http://127.0.0.1:{host.operator_port}",
                "credentialFile": "/run/subspace-secrets/maintenance/operator-token"}}
        for role in ("store", "subs", "proxy"):
            self.config["services"][role] = {"user": "subspace-" + role, "group": "subspace-" + role,
                "command": ["/usr/bin/python3", "fixture-service.py", role, "${INSTALLATION_CONFIG}"] if role != "proxy" else
                    ["bin/node", "native/proxy.mjs", "--serve", "${INSTALLATION_CONFIG}"],
                "credentials": {"operator": "operator-token"} if role == "store" else {"registry": "registry-token"} if role == "subs" else
                    {"tls-cert": "tls-cert", "tls-key": "tls-key"}}
        for name, operation in (("preflight", "preflight"), ("reconcile", "reconcile"), ("controllerReadiness", "ready")):
            self.config["commands"][name] = ["/usr/bin/python3", "fixture-lifecycle.py", operation, "${INSTALLATION_CONFIG}"]
        host.put("/etc/subspace-store/installation.json", self.config)
        host.put("/etc/subspace-store/store.json", {"database": "/srv/subspace-store/store/store.db", "listen": {"buyer": host.buyer_port, "operator": host.operator_port}})
        host.put("/etc/subspace-store/runner.json", {"controller": {"dir": "/srv/subspace-store/controller", "snapshot_dir": "/srv/subspace-store/checkpoints-runtime"},
            "subs": {"data_dir": "/srv/subspace-store/subs", "url": f"http://127.0.0.1:{host.subs_port}"}})
        roles = {"store": ["operator-token"], "subs": ["registry-token"], "proxy": ["tls-cert", "tls-key"],
                 "maintenance": ["recovery-ssh-key", "recovery-key", "operator-token"]}
        self.secrets = {"version": 1, "source": "infisical", "endpoint": f"https://{host.bridge_address}:{host.api.server_port}",
            "projectId": "fixture-project", "environment": "fixture", "outputRoot": "/run/subspace-secrets",
            "caFile": "/etc/subspace-store/fixture-ca.pem", "roles": {}}
        for role, names in roles.items():
            self.secrets["roles"][role] = {name: {"name": name, "path": "/installation",
                "encoding": "base64-key32" if name == "recovery-key" else "text"} for name in names}
        host.put("/etc/subspace-store/secrets.json", self.secrets)
        host.put("/etc/subspace-store/recovery-known-hosts", host.known)
        host.put("/etc/subspace-store/recovery.json", {"version": 1, "installation": "fixture", "host": host.bridge_address,
            "port": host.recovery_port, "user": "recovery", "knownHostsFile": "/etc/subspace-store/recovery-known-hosts",
            "identityFile": "/run/credentials/subspace-fixture-store.service/recovery-ssh-key",
            "encryptionKeyFile": "/run/credentials/subspace-fixture-store.service/recovery-key",
            "connectTimeoutSeconds": 2, "operationTimeoutSeconds": 30})
        host.exec("mkdir", "-p", "/srv/subspace-store/onboarding")
        files = {"core-wallet.backup": b"fixture original Core backup", "spaced-wallet.export": b"fixture original spaced export"}
        for name, data in files.items():
            host.put("/srv/subspace-store/onboarding/" + name, data, 0o600)
        host.put("/srv/subspace-store/onboarding/manifest.json", {"label": "onboarding", "store_journal": 0,
            "controller_journal": 0, "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}, 0o600)
        self.make_release("fixture-v1")
        self.make_release("fixture-v2", "fixture-v1")
        self.make_release("fixture-broken", "fixture-v2", fail=True)

    def make_release(self, name, prior=None, fail=False):
        host = self.host
        source = host.root / (name + "-source")
        source.mkdir()
        for directory in ("native", "client"):
            shutil.copytree(DRAFT / directory, source / directory, ignore=shutil.ignore_patterns("test*", "__pycache__", "*.pyc"))
        for file in ("fixture-service.py", "fixture-lifecycle.py"):
            shutil.copyfile(HERE / file, source / file)
        # The normal-checkpoint platform case uses the actual snapshot method
        # from the separately qualified backend integration capture.
        application_source=Path(os.environ.get('SUBSPACE_PACKAGE_APPLICATION_SOURCE',str(DRAFT.parent)))
        for directory in ('controller','runner','service'):
            shutil.copytree(application_source/directory,source/'app'/directory,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
        shutil.copyfile(HERE/'fixture-normal-checkpoint.py',source/'app/runner/__main__.py')
        write(source / "fixture-version.json", {"release": name, "fail": fail})
        write(source / "bin/node", "#!/bin/sh\nexec /usr/local/bin/node \"$@\"\n", 0o755)
        output = host.root / (name + "-artifact")
        build(source, output, name, "1" * 40, host.signer, [prior] if prior else [], [prior] if prior else [])
        host.exec("mkdir", "-p", "/var/lib/subspace-incoming/" + name)
        for suffix in ("manifest.json", "manifest.sig", "tar.gz"):
            host.copy(output / (name + "." + suffix), "/var/lib/subspace-incoming/" + name + "/" + ("release.tar.gz" if suffix == "tar.gz" else suffix))

    def installer(self, release=None, *, success=True, flags=()):
        args = ["/usr/bin/python3", "/bootstrap/native/installer.py", "--config", "/etc/subspace-store/installation.json"]
        if release is None:
            args.append("status")
        else:
            path = "/var/lib/subspace-incoming/" + release
            args.extend(["apply", "--manifest", path + "/manifest.json", "--signature", path + "/manifest.sig", "--artifact", path + "/release.tar.gz", *flags])
        result = self.host.exec(*args, success=False, timeout=120)
        if success and result.returncode:
            journal = self.host.exec("journalctl", "--no-pager", "-n", "60", "--unit=subspace-*", success=False)
            unit = self.host.exec("systemctl", "cat", "subspace-secrets-fixture-store.service", success=False)
            probe = self.host.exec("systemd-run", "--wait", "--pipe", "--property=User=subspace-secrets",
                "--property=LoadCredentialEncrypted=bootstrap:/etc/credstore.encrypted/subspace-fixture-infisical.cred",
                "python3", "-c", "import os,json,stat; p=os.environ['CREDENTIALS_DIRECTORY']; s=os.lstat(p+'/bootstrap'); d=os.lstat(p); print(json.dumps({'directory':p,'euid':os.geteuid(),'egid':os.getegid(),'directoryMode':oct(d.st_mode&511),'directoryUid':d.st_uid,'directoryGid':d.st_gid,'directorySymlink':stat.S_ISLNK(d.st_mode),'fileMode':oct(s.st_mode&511),'fileUid':s.st_uid,'fileGid':s.st_gid,'fileLinks':s.st_nlink,'fileSymlink':stat.S_ISLNK(s.st_mode),'readOnlyMount':bool(os.statvfs(p).f_flag&os.ST_RDONLY)}))", success=False)
            self.fail(result.stdout.decode() + "\n" + journal.stdout.decode(errors="replace") + "\n" + unit.stdout.decode() +
                "\ncredential probe: " + probe.stdout.decode() + probe.stderr.decode() + "\nAPI request count: " + str(len(self.host.requests)))
        return json.loads(result.stdout), result.returncode

    def sql(self, statement):
        code = "import sqlite3,json; c=sqlite3.connect('/srv/subspace-store/store/store.db'); r=c.execute(" + repr(statement) + "); print(json.dumps(r.fetchall())); c.commit()"
        return json.loads(self.host.exec("python3", "-c", code).stdout)

    def alchemy(self, operation, release="fixture-v1"):
        host = self.host
        directory = host.root / "alchemy-private"
        directory.mkdir(exist_ok=True, mode=0o700)
        artifacts = directory / "release"
        artifacts.mkdir(exist_ok=True)
        for suffix, name in (("manifest.json", "manifest.json"), ("manifest.sig", "manifest.sig"), ("tar.gz", "release.tar.gz")):
            shutil.copyfile(host.root / (release + "-artifact") / (release + "." + suffix), artifacts / name)
        deploy = {"version": 1, "hosts": {"fixture": {"host": "127.0.0.1", "port": host.guest.port,
            "user": "root", "identityFile": str(host.guest.identity), "knownHostsFile": str(host.guest.known),
            "installer": "/bootstrap/native/installer.py", "installationConfig": "/etc/subspace-store/installation.json",
            "incomingDirectory": "/var/lib/alchemy-incoming"}}}
        write(directory / "deploy.json", deploy, 0o600)
        environment = {**os.environ, "SUBSPACE_DEPLOY_CONFIG": str(directory / "deploy.json"),
            "SUBSPACE_RELEASE_DIRECTORY": str(artifacts), "SUBSPACE_RELEASE": release,
            "SUBSPACE_MANIFEST_DIGEST": hashlib.sha256((artifacts / "manifest.json").read_bytes()).hexdigest()}
        result = subprocess.run(["node", str(DRAFT / "alchemy/fixture-driver.ts"), operation], cwd=directory,
            env=environment, capture_output=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout.decode(errors="replace") + result.stderr.decode(errors="replace"))
        persisted = b"".join(p.read_bytes() for p in directory.rglob("*") if p.is_file() and p not in [directory / "deploy.json"] and not p.is_relative_to(artifacts))
        for value in (host.client_key.read_bytes(), host.guest.identity.read_bytes(), host.values["operator-token"].encode(), host.values["recovery-key"].encode()):
            self.assertNotIn(value, persisted + result.stdout + result.stderr)
        return result

    def test_actual_package_install_update_restarts_fences_and_failures(self):
        host = self.host
        first, _ = self.installer("fixture-v1")
        self.assertTrue(first["ready"])
        self.assertTrue(first["paused"])
        self.assertEqual(first["reviewCount"], 7)
        outcome=[]
        # The fixed helper verifies the real controller's module/cwd/UID and
        # process-start fingerprint; no sudo intermediary participates.
        original_exec=host.exec
        def launch_checkpoint():
            script="import os; os.chdir('/opt/subspace-store/current/app'); os.execv('/usr/bin/python3',['/usr/bin/python3','-m','runner','/etc/subspace-store/installation.json'])"
            outcome.append(original_exec('/usr/bin/python3','-c',script,success=False,timeout=90))
        thread=threading.Thread(target=launch_checkpoint);thread.start()
        try:
            deadline=time.monotonic()+15
            while host.exec('test','-f','/run/subspace-store/normal-snapshot.ready',success=False).returncode:
                self.assertTrue(thread.is_alive(),outcome[0].stderr.decode() if outcome else 'checkpoint exited')
                self.assertLess(time.monotonic(),deadline);time.sleep(0.05)
            competing=host.exec('systemctl','start','subspace-fixture-subs.service',success=False)
            self.assertNotEqual(competing.returncode,0)
            self.assertEqual(host.exec('systemctl','show','subspace-fixture-subs.service','--property=MainPID','--value').stdout.strip(),b'0')
            host.put('/run/subspace-store/normal-snapshot.continue','continue',0o600)
        finally:thread.join(timeout=95)
        self.assertFalse(thread.is_alive());self.assertEqual(outcome[0].returncode,0,outcome[0].stderr.decode())
        self.assertEqual(json.loads(outcome[0].stdout)['controller_journal'],0)
        # The pinned engine adopts the same verified manual artifact. Removing
        # or destroying its state preserves the host and its complete history.
        self.alchemy("deploy")
        self.alchemy("remove")
        self.assertEqual(self.installer()[0]["release"], "fixture-v1")
        self.assertEqual(self.sql("select address from preserved_history"), [["fixture-historical-payment-address"]])
        self.alchemy("deploy")
        self.alchemy("destroy")
        self.assertEqual(self.installer()[0]["release"], "fixture-v1")
        probe = host.exec("systemd-run", "--wait", "--pipe", "--property=User=subspace-secrets",
            "--property=LoadCredentialEncrypted=bootstrap:/etc/credstore.encrypted/subspace-fixture-infisical.cred",
            "/usr/local/bin/node", "--input-type=module", "-e",
            "import {protectedFile,sha} from 'file:///bootstrap/client/transport.mjs'; const p=process.env.CREDENTIALS_DIRECTORY+'/bootstrap'; const value=protectedFile(p,4096); console.log(JSON.stringify({case:'O151',verified:true,sha256:sha(value)}));")
        positive = json.loads(probe.stdout)
        self.assertTrue(positive["verified"])
        positive.update(platform="Ubuntu24.04Minimal20261105/systemd255/Node24.14.0", scope="test-only encrypted credential in disposable KVM guest",
            helperSha256=hashlib.sha256((DRAFT / "client/systemd-credential.mjs").read_bytes()).hexdigest())
        (DRAFT / "evidence/O151-systemd255-credential-positive.json").write_text(json.dumps(positive, sort_keys=True) + "\n")
        self.assertEqual(self.installer("fixture-v1")[0]["unchanged"], True)
        self.sql("update fixture_settings set blocker='active_hold'")
        blocked, code = self.installer("fixture-v2", success=False)
        self.assertEqual(code, 2)
        self.assertEqual(blocked["blockers"], [{"kind": "active_hold", "id": "fixture-order"}])
        self.assertEqual(self.installer()[0]["release"], "fixture-v1")
        self.sql("update fixture_settings set blocker=null")
        updated, _ = self.installer("fixture-v2")
        self.assertEqual(updated["release"], "fixture-v2")
        self.assertEqual(self.sql("select address from preserved_history"), [["fixture-historical-payment-address"]])
        receipt = json.loads(host.exec("cat", "/srv/subspace-store/lifecycle/installed.json").stdout)
        self.assertIsNotNone(receipt["checkpoint"])
        self.assertEqual(self.sql("select review_count from fixture_settings"), [[7]])
        # The secret service is a fresh oneshot dependency on every new start.
        host.api_available = False
        restarted = host.exec("systemctl", "restart", "subspace-fixture-store.service", success=False)
        self.assertNotEqual(restarted.returncode, 0)
        self.assertEqual(host.exec("systemctl", "show", "subspace-fixture-store.service", "--property=MainPID", "--value").stdout.strip(), b"0")
        host.api_available = True
        host.exec("systemctl", "reset-failed", "subspace-secrets-fixture-store.service")
        host.exec("systemctl", "start", "subspace-fixture-store.service")
        failed, code = self.installer("fixture-broken", success=False)
        self.assertEqual(code, 2)
        self.assertTrue(failed["paused"])
        status, _ = self.installer()
        self.assertFalse(status["ready"])
        self.assertTrue(status["paused"])
        restarted = host.exec("systemctl", "start", "subspace-fixture-subs.service", success=False)
        # Type=simple may acknowledge start before the fenced launcher exits.
        deadline = time.monotonic() + 5
        while host.exec("systemctl", "show", "subspace-fixture-subs.service", "--property=MainPID", "--value").stdout.strip() != b"0":
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.05)
        self.assertEqual(host.exec("systemctl", "show", "subspace-fixture-subs.service", "--property=ExecMainStatus", "--value").stdout.strip(), b"75")
        rolled, _ = self.installer("fixture-v2", flags=("--rollback",))
        self.assertEqual(rolled["release"], "fixture-v2")
        self.assertTrue(rolled["paused"])
        (DRAFT / "evidence/package-platform-rehearsal.json").write_text(json.dumps({"scope": "real installer, systemd, TLS, Infisical HTTP and encrypted SSH; recording application and native-node fixtures",
            "productionDomainQualification": False, "fresh": first, "updated": updated, "failed": failed, "rolledBack": rolled,
            "historyPreserved": True, "reviewCountPreserved": True, "infisicalUnavailableStartRefused": True,
            "alchemyVersion": "2.0.0-beta.86", "alchemySameArtifact": True, "alchemyRemovalAndDestroyPreserveData": True,
            "ordinaryActualControllerSnapshotRemoteAck": True, "competingSubsRestartRefusedDuringCopy": True,
            "installerSha256": hashlib.sha256((DRAFT / "native/installer.py").read_bytes()).hexdigest()}, sort_keys=True) + "\n")


if __name__ == "__main__":
    unittest.main()
