"""Disposable hosts and HTTPS secret source. No product checkout mutation."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit
import uuid

from progress import command, phase, traced

HERE = Path(__file__).resolve().parent
DRAFT = HERE.parent


def run(arguments, *, data=None, timeout=30, success=True):
    with command(arguments):
        result = subprocess.run(arguments, input=data, capture_output=True, timeout=timeout)
        if success and result.returncode:
            raise RuntimeError(f"fixture command failed: {arguments[:3]!r}: {result.stdout.decode(errors='replace')[-1000:]} {result.stderr.decode(errors='replace')[-1000:]}")
        return result


def port():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return server.getsockname()[1]


def write(path, value, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(value).encode() if isinstance(value, (dict, list)) else value.encode() if isinstance(value, str) else value)
    path.chmod(mode)


class Hosts:
    def __init__(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="subspace-native-package-")
        self.root = Path(self.temporary.name)
        self.native = "subspace-native-" + uuid.uuid4().hex[:10]
        self.remote = "subspace-recovery-" + uuid.uuid4().hex[:10]
        self.containers = []
        self.api = None
        self.guest = None
        self.use_vm = os.environ.get("SUBSPACE_PACKAGE_FIXTURE_BACKEND", "vm") == "vm"
        self.bridge_address = "10.0.2.2" if self.use_vm else "127.0.0.1"
        self.values = {}
        self.requests = []
        self.api_available = True
        self.tls_port, self.buyer_port, self.operator_port, self.subs_port = [port() for _ in range(4)]
        self.recovery_port = port()
        try:
            with phase('hosts.keys'):
                self.keys()
            with phase('hosts.recovery'):
                self.start_recovery()
            with phase('hosts.api'):
                self.start_api()
            with phase('hosts.native'):
                self.start_native()
        except BaseException:
            self.close()
            raise

    def keys(self):
        self.cert, self.tls_key = self.root / "fixture-cert.pem", self.root / "fixture-tls.key"
        run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3", "-subj", "/CN=fixture",
             "-addext", "subjectAltName=IP:127.0.0.1,IP:10.0.2.2,DNS:store.fixture.test", "-keyout", str(self.tls_key), "-out", str(self.cert)])
        self.cert.chmod(0o644)
        self.tls_key.chmod(0o600)
        self.signer = self.root / "release-signing.key"
        self.trust = self.root / "release-trust.pem"
        run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(self.signer)])
        self.signer.chmod(0o600)
        run(["openssl", "pkey", "-in", str(self.signer), "-pubout", "-out", str(self.trust)])
        self.trust.chmod(0o644)
        self.client_key = self.root / "client"
        run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", str(self.client_key)])

    def start_recovery(self):
        server = self.root / "recovery-server"
        server.mkdir(mode=0o755)
        run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", str(server / "host")])
        write(server / "client.pub", self.client_key.with_suffix(".pub").read_bytes())
        configuration = "\n".join([f"Port {self.recovery_port}", "ListenAddress 127.0.0.1", "HostKey /fixture/host",
            "PidFile /tmp/sshd.pid", "AuthorizedKeysFile /fixture/client.pub", "StrictModes no", "UsePAM no",
            "PasswordAuthentication no", "KbdInteractiveAuthentication no", "AuthenticationMethods publickey",
            "AllowUsers recovery", "DisableForwarding yes", "PermitTTY no", "LogLevel ERROR",
            "ForceCommand /usr/bin/python3 /code/helper.py --root /recovery --installation fixture"]) + "\n"
        write(server / "sshd_config", configuration, 0o600)
        run(["docker", "run", "--detach", "--rm", "--name", self.remote, "--network", "host",
             "--mount", f"type=bind,source={server},target=/fixture,readonly",
             "--mount", f"type=bind,source={DRAFT / 'recovery'},target=/code,readonly", "subspace-recovery-ssh-fixture:20261112"])
        self.containers.append(self.remote)
        public = " ".join((server / "host.pub").read_text().split()[:2])
        self.known = f"[{self.bridge_address}]:{self.recovery_port} {public}\n"

    def start_api(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                if not owner.api_available:
                    self.send_error(503)
                    return
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path != "/api/v1/auth/universal-auth/login" or body != {"clientId": "fixture", "clientSecret": "fixture-bootstrap"}:
                    self.send_error(403)
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"accessToken":"fixture-access","tokenType":"Bearer"}')

            def do_GET(self):
                query = parse_qs(urlsplit(self.path).query)
                name = unquote(urlsplit(self.path).path.split("/")[-1])
                owner.requests.append((name, query))
                if not owner.api_available or self.headers.get("Authorization") != "Bearer fixture-access" or name not in owner.values:
                    self.send_error(403)
                    return
                if query.get("projectId") != ["fixture-project"] or query.get("environment") != ["fixture"] or query.get("secretPath") != ["/installation"] or query.get("includeImports") != ["false"] or query.get("expandSecretReferences") != ["false"]:
                    self.send_error(403)
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"secret": {"secretKey": name, "secretPath": "/installation", "environment": "fixture",
                    "workspace": "fixture-project", "type": "shared", "secretValueHidden": False, "secretValue": owner.values[name]}}).encode())

        self.api = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.cert, self.tls_key)
        self.api.socket = context.wrap_socket(self.api.socket, server_side=True)
        self.thread = threading.Thread(target=self.api.serve_forever, daemon=True)
        self.thread.start()
        self.values = {"operator-token": "fixture-operator-service-token-32-bytes", "registry-token": "fixture-registry-service-token-32-bytes",
            "tls-cert": self.cert.read_text(), "tls-key": self.tls_key.read_text(), "recovery-ssh-key": self.client_key.read_text(),
            "recovery-key": base64.b64encode(os.urandom(32)).decode()}

    def start_native(self):
        if self.use_vm:
            from vm import Guest
            self.guest = Guest(self.root)
            self.initialize_native()
            return
        node = shutil.which("node")
        run(["docker", "run", "--detach", "--rm", "--name", self.native, "--privileged", "--cgroupns=private", "--network", "host",
             "--tmpfs", "/run", "--tmpfs", "/run/lock", "--mount", f"type=bind,source={DRAFT},target=/bootstrap,readonly",
             "--mount", f"type=bind,source={node},target=/usr/local/bin/node,readonly", "subspace-native-systemd-fixture:20261112"])
        self.containers.append(self.native)
        for _ in range(50):
            state = self.exec("systemctl", "show", "--property=SystemState", "--value", success=False)
            if state.stdout.strip() in (b"running", b"degraded"):
                break
            time.sleep(0.1)
        self.initialize_native()

    def initialize_native(self):
        self.exec("mkdir", "-p", "/etc/subspace-store", "/etc/credstore.encrypted")
        self.copy(self.trust, "/etc/subspace-store/trust.pem")
        self.copy(self.cert, "/etc/subspace-store/fixture-ca.pem")
        bootstrap = self.root / "bootstrap"
        write(bootstrap, {"clientId": "fixture", "clientSecret": "fixture-bootstrap"}, 0o600)
        self.copy(bootstrap, "/run/fixture-bootstrap")
        self.exec("systemd-creds", "encrypt", "--with-key=host", "--name=bootstrap", "/run/fixture-bootstrap", "/etc/credstore.encrypted/subspace-fixture-infisical.cred")
        self.exec("rm", "/run/fixture-bootstrap")

    def copy(self, source, destination):
        if self.guest:
            self.guest.copy(source, destination)
            return
        if destination.startswith("/run/"):
            program = "import os,sys; p=sys.argv[1]; open(p,'wb').write(sys.stdin.buffer.read()); os.chmod(p,int(sys.argv[2],8))"
            run(["docker", "exec", "-i", self.native, "python3", "-c", program, destination, oct(Path(source).stat().st_mode & 0o777)], data=Path(source).read_bytes())
        else:
            run(["docker", "cp", str(source), self.native + ":" + destination])
            self.exec("chown", "root:root", destination)

    def put(self, destination, value, mode=0o644):
        source = self.root / ("copy-" + uuid.uuid4().hex)
        write(source, value, mode)
        self.copy(source, destination)

    def exec(self, *arguments, success=True, timeout=30):
        if self.guest:
            return self.guest.exec(*arguments, success=success, timeout=timeout)
        return run(["docker", "exec", self.native, *arguments], timeout=timeout, success=success)

    @traced("hosts.close")
    def close(self):
        if self.guest:
            self.guest.close()
        for container in reversed(self.containers):
            run(["docker", "rm", "--force", container], success=False)
        if self.api:
            self.api.shutdown()
            self.api.server_close()
            self.thread.join()
        self.temporary.cleanup()
