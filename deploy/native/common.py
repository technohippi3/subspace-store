"""Private host configuration and bounded, scrubbed process operations."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\Z")


class Refused(Exception):
    def __init__(self, code, details=None):
        self.code = code
        self.details = details


def require(condition, code="invalid-configuration"):
    if not condition:
        raise Refused(code)


def json_file(path, maximum=65536, secret=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                info.st_size <= maximum and info.st_uid in (0, os.geteuid()) and
                not info.st_mode & (0o077 if secret else 0o022), "unsafe-file")
        with os.fdopen(fd, "rb", closefd=False) as file:
            data = file.read(maximum + 1)
        require(len(data) <= maximum, "oversize-file")
        return json.loads(data)
    finally:
        os.close(fd)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def public_directory(path, *, parents=False, exist_ok=False):
    """Create only public installation directories independently of umask.

    Existing ancestors retain their permissions; this never widens private
    state, credential directories or an operator-provisioned parent.
    """
    path = Path(path)
    if parents and not path.parent.exists():
        public_directory(path.parent, parents=True, exist_ok=True)
    try:
        path.mkdir(mode=0o755)
    except FileExistsError:
        if not exist_ok:
            raise
        require(path.is_dir() and not path.is_symlink(), "unsafe-public-directory")
        return
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        require(os.fstat(fd).st_uid == os.geteuid(), "unsafe-public-directory")
        os.fchmod(fd, 0o755)
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as file:
            json.dump(value, file, sort_keys=True, separators=(",", ":"))
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def command(arguments, *, input=None, maximum=4 * 1024 * 1024, timeout=30, cwd=None):
    """Capture output in a bounded temporary file; never surface child errors."""
    require(isinstance(arguments, list) and arguments and
            all(isinstance(a, str) and "\0" not in a and len(a) <= 4096 for a in arguments))
    import resource

    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))

    with tempfile.TemporaryFile() as output:
        try:
            process = subprocess.run(arguments, input=input, stdout=output,
                                     stderr=subprocess.DEVNULL, timeout=timeout,
                                     cwd=cwd, preexec_fn=limits, check=False,
                                     env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        except (OSError, subprocess.TimeoutExpired):
            raise Refused("command-unavailable") from None
        require(process.returncode == 0, "command-refused")
        output.seek(0)
        data = output.read(maximum + 1)
        require(len(data) <= maximum, "oversize-response")
        return data


def config(path):
    value = json_file(path)
    fields = {"version", "installation", "baseDirectory", "releaseDirectory", "currentPath",
              "runtimeDirectory", "trustKey", "storeConfig", "runnerConfig", "secretsConfig",
              "recoveryConfig", "walletBackupDirectory", "network", "minimumFreeBytes",
              "services", "commands", "operator", "publicOrigin", "tls"}
    require(isinstance(value, dict) and fields <= set(value) <= fields | {"profile", "nativeRpc", "proverUrl"} and value["version"] == 1)
    require(isinstance(value["installation"], str) and ID.fullmatch(value["installation"]))
    require(value["network"] in ("regtest", "mainnet"))
    for name in fields - {"version", "installation", "network", "minimumFreeBytes", "services", "commands", "operator", "publicOrigin", "tls"}:
        require(isinstance(value[name], str) and Path(value[name]).is_absolute() and
                re.fullmatch(r"/[a-zA-Z0-9_./-]{1,4095}", value[name]) and ".." not in Path(value[name]).parts)
    require(type(value["minimumFreeBytes"]) is int and value["minimumFreeBytes"] >= 0)
    require(set(value["services"]) == {"store", "subs", "proxy"})
    for role, service in value["services"].items():
        required = {"user", "group", "command", "credentials"}
        require(required <= set(service) <= required | {"externalCredentials"} and
                re.fullmatch(r"[a-z_][a-z0-9_-]{0,30}", service["user"]) and
                re.fullmatch(r"[a-z_][a-z0-9_-]{0,30}", service["group"]) and
                service["user"] != "root" and service["group"] != "root")
        require(isinstance(service["command"], list) and service["command"])
        require(isinstance(service["credentials"], dict) and
                all(ID.fullmatch(k) and ID.fullmatch(v) for k, v in service["credentials"].items()))
        for credential, source in service.get("externalCredentials", {}).items():
            require(ID.fullmatch(credential) and isinstance(source, str) and Path(source).is_absolute() and ".." not in Path(source).parts)
    if "profile" in value:
        require(value["profile"] == "existing-native-linux-x86_64-systemd255" and "nativeRpc" in value and "proverUrl" in value)
    require(set(value["commands"]) == {"preflight", "reconcile", "controllerReadiness"})
    require(set(value["operator"]) == {"url", "credentialFile"})
    require(re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", value["operator"]["url"]))
    require(isinstance(value["publicOrigin"], str) and value["publicOrigin"].startswith("https://"))
    require(set(value["tls"]) == {"certificateFile", "privateKeyFile", "caFile", "listenPort", "listenAddress"} and
            value["tls"]["listenAddress"] in ("127.0.0.1", "0.0.0.0") and
            type(value["tls"]["listenPort"]) is int and 1 <= value["tls"]["listenPort"] <= 65535)
    value["_file"] = str(Path(path).resolve())
    return value


def paths(config):
    base = Path(config["baseDirectory"])
    return {"lock": base / "lifecycle" / "maintenance.lock", "latch": base / "lifecycle" / "maintenance.json",
            "receipt": base / "lifecycle" / "installed.json", "checkpoints": base / "checkpoints",
            "subsLock": base / 'lifecycle/subs.lock', "subsLatch": base / 'lifecycle/subs-maintenance.json'}


def expand(config, release, arguments):
    replacements = {"${STORE_CONFIG}": config["storeConfig"], "${RUNNER_CONFIG}": config["runnerConfig"],
                    "${INSTALLATION_CONFIG}": config["_file"], "${RELEASE}": str(release)}
    result = [str(Path(release) / a.removeprefix('${RELEASE}/')) if isinstance(a, str) and a.startswith('${RELEASE}/')
              else replacements.get(a, a) for a in arguments]
    require(result and all(isinstance(a, str) and "\0" not in a and len(a) <= 4096 for a in result))
    if not result[0].startswith("/"):
        require(".." not in Path(result[0]).parts)
        result[0] = str(Path(release) / result[0])
    return result
