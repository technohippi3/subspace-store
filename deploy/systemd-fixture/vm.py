"""A disposable KVM guest with an independently pinned test SSH host key."""
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import time
import uuid

from fixtures import DRAFT, port, run, write


class Guest:
    def __init__(self, root):
        self.root = Path(root)
        self.process = None
        self.port = port()
        self.identity = self.root / "vm-client"
        self.host_key = self.root / "vm-host"
        for key in (self.identity, self.host_key):
            run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", str(key)])
        public = " ".join(self.host_key.with_suffix(".pub").read_text().split()[:2])
        self.known = self.root / "vm-known-hosts"
        write(self.known, f"[127.0.0.1]:{self.port} {public}\n", 0o600)
        seed = self.root / "seed"
        seed.mkdir(mode=0o700)
        metadata = {"instance-id": "subspace-fixture-" + uuid.uuid4().hex, "local-hostname": "fixture"}
        userdata = {"disable_root": False, "ssh_pwauth": False, "ssh_deletekeys": False,
            "users": [{"name": "root", "lock_passwd": True, "ssh_authorized_keys": [self.identity.with_suffix(".pub").read_text().strip()]}],
            "ssh_keys": {"ed25519_private": self.host_key.read_text(), "ed25519_public": self.host_key.with_suffix(".pub").read_text()},
            "package_update": False, "package_upgrade": False}
        write(seed / "meta-data", metadata, 0o600)
        write(seed / "user-data", "#cloud-config\n" + json.dumps(userdata) + "\n", 0o600)
        iso = self.root / "seed.iso"
        run(["genisoimage", "-quiet", "-output", str(iso), "-volid", "cidata", "-joliet", "-rock", str(seed / "user-data"), str(seed / "meta-data")])
        base = Path(os.environ.get('SUBSPACE_PACKAGE_VM_IMAGE',str(DRAFT / "vm-cache/ubuntu-24.04-minimal-cloudimg-amd64.img")))
        disk = self.root / "guest.qcow2"
        run(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(base), str(disk), "32G"])
        self.serial = self.root / "serial.log"
        self.error = (self.root / "qemu.log").open("wb")
        accelerator=os.environ.get('SUBSPACE_PACKAGE_VM_ACCELERATOR','kvm')
        if accelerator not in ('kvm','tcg'):raise RuntimeError('explicit supported fixture accelerator required')
        self.process = subprocess.Popen(["qemu-system-x86_64", "-accel", accelerator, "-cpu", "host" if accelerator=='kvm' else 'max', "-m", "2048", "-smp", "2",
            "-display", "none", "-monitor", "none", "-serial", "file:" + str(self.serial),
            "-drive", f"file={disk},if=virtio,format=qcow2", "-drive", f"file={iso},if=virtio,format=raw,readonly=on",
            "-nic", f"user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:{self.port}-:22"], stdout=subprocess.DEVNULL, stderr=self.error)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.close()
                raise RuntimeError("disposable guest stopped before SSH")
            if self.exec("true", success=False, timeout=3).returncode == 0:
                break
            time.sleep(0.2)
        else:
            self.close()
            raise RuntimeError("disposable guest SSH deadline exceeded")
        self.exec("cloud-init", "status", "--wait", timeout=120)
        self.exec("mkdir", "-p", "/bootstrap/native", "/bootstrap/client")
        self.copy_tree(DRAFT / "native", "/bootstrap/native")
        self.copy_tree(DRAFT / "client", "/bootstrap/client")
        self.copy(shutil.which("node"), "/usr/local/bin/node")
        self.exec("chmod", "0755", "/usr/local/bin/node")

    def options(self):
        return ["-F", "/dev/null", "-oBatchMode=yes", "-oIdentitiesOnly=yes", "-oIdentityAgent=none",
            "-oStrictHostKeyChecking=yes", "-oGlobalKnownHostsFile=/dev/null", "-oUserKnownHostsFile=" + str(self.known),
            "-oConnectTimeout=2", "-oServerAliveInterval=2", "-oServerAliveCountMax=2", "-i", str(self.identity)]

    def exec(self, *arguments, success=True, timeout=30):
        return run(["ssh", *self.options(), "-T", "-p", str(self.port), "root@127.0.0.1", shlex.join(arguments)], success=success, timeout=timeout)

    def copy(self, source, destination):
        run(["scp", *self.options(), "-P", str(self.port), str(source), f"root@127.0.0.1:{destination}"], timeout=60)
        self.exec("chown", "root:root", destination)

    def copy_tree(self, source, destination):
        for file in Path(source).iterdir():
            if file.is_file() and file.suffix in (".py", ".mjs") and not file.name.startswith("test"):
                self.copy(file, destination + "/" + file.name)

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if hasattr(self, "error"):
            self.error.close()

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
