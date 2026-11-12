"""Only installer-owned native services and per-start secret retrieval."""
import grp
import os
from pathlib import Path
import pwd
import shlex
from common import ID, command, json_file, paths, require, sync_directory

UNIT_DIRECTORY = Path("/usr/lib/systemd/system")


def prepare(config, release):
    require(os.geteuid() == 0, "root-required")
    for service in config["services"].values():
        try:
            pwd.getpwnam(service["user"])
        except KeyError:
            command(["/usr/sbin/useradd", "--system", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", service["user"]])
        require(pwd.getpwnam(service["user"]).pw_uid != 0)
    try:
        pwd.getpwnam("subspace-secrets")
    except KeyError:
        command(["/usr/sbin/useradd", "--system", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", "subspace-secrets"])
    base = Path(config["baseDirectory"])
    base.mkdir(parents=True, exist_ok=True, mode=0o755)
    state = paths(config)
    state["lock"].parent.mkdir(exist_ok=True, mode=0o755)
    for name in ('lock','subsLock'):
        fd = os.open(state[name], os.O_CREAT | os.O_RDONLY | os.O_NOFOLLOW, 0o644)
        os.close(fd)
    for name in ("receipt", "latch"):
        require(not state[name].is_symlink(), "unsafe-lifecycle-state")
    state["checkpoints"].mkdir(exist_ok=True, mode=0o700)
    runtime, runner = json_file(config["storeConfig"]), json_file(config["runnerConfig"])
    for role, directory in (("store", Path(runtime["database"]).parent), ("store", Path(runner["controller"]["dir"])),
                            ("store", Path(runner["controller"]["snapshot_dir"])), ("subs", Path(runner["subs"]["data_dir"]))):
        user = pwd.getpwnam(config["services"][role]["user"])
        if not directory.exists():
            directory.mkdir(parents=True, mode=0o700)
            os.chown(directory, user.pw_uid, user.pw_gid)
        require(directory.is_dir() and not directory.is_symlink() and directory.stat().st_uid == user.pw_uid,
                "persistent-data-owner-mismatch")
    Path(config["releaseDirectory"]).mkdir(parents=True, exist_ok=True, mode=0o755)
    Path(config["currentPath"]).parent.mkdir(parents=True, exist_ok=True)
    secrets = json_file(config["secretsConfig"])
    secret_root = Path(secrets["outputRoot"])
    require(secret_root.is_absolute() and secret_root.parts[:2] == ('/', 'run') and
            len(secret_root.parts) > 2 and all(ID.fullmatch(part) for part in secret_root.parts[2:]),
            "runtime-storage-required")
    runtime_directory = '/'.join(secret_root.parts[2:])
    secret_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    secret_identity = pwd.getpwnam("subspace-secrets")
    os.chown(secret_root, secret_identity.pw_uid, secret_identity.pw_gid)
    installed = []
    # Bootstrap lives outside the release and is provisioned by the operator.
    require("maintenance" in secrets["roles"], "missing-maintenance-secrets")
    for role in secrets["roles"]:
        fetch_name = "subspace-secrets-" + config["installation"] + "-" + role + ".service"
        fetch_lines = ["[Unit]", "Description=Fetch installation runtime credentials", "After=network-online.target", "Wants=network-online.target",
            "[Service]", "Type=oneshot", "User=subspace-secrets", "Group=subspace-secrets", "UMask=0077", "TimeoutStartSec=30",
            "RuntimeDirectory=" + runtime_directory, "RuntimeDirectoryMode=0700", "RuntimeDirectoryPreserve=yes",
            "PrivateTmp=yes", "ProtectSystem=strict", "ProtectHome=yes", "NoNewPrivileges=yes", "ReadWritePaths=" + str(secret_root),
            "ExecStart=/usr/bin/python3 " + str(release / "native/fetch-secrets.py") + " --config " + config["secretsConfig"] + " --role " + role]
        if secrets["source"] == "infisical":
            fetch_lines.append("LoadCredentialEncrypted=bootstrap:/etc/credstore.encrypted/subspace-" + config["installation"] + "-infisical.cred")
        else:
            fetch_lines[-1]="ExecStart=/usr/bin/python3 " + str(release / "native/fetch-secrets.py") + " --config %d/source-config --role " + role
            fetch_lines.append('LoadCredential=source-config:'+config['secretsConfig'])
            fetch_lines.extend("LoadCredential=offline-" + name + ":" + config["runtimeDirectory"] + "/attended/" + role + "/" + name for name in secrets["roles"][role])
        (UNIT_DIRECTORY / fetch_name).write_text("\n".join(fetch_lines) + "\n")
        installed.append(fetch_name)
    for role, service in config["services"].items():
        require(role in secrets["roles"], "missing-service-secrets")
        fetch_name = "subspace-secrets-" + config["installation"] + "-" + role + ".service"
        name = "subspace-" + config["installation"] + "-" + role + ".service"
        lines = ["[Unit]", "Description=Native installation " + role, "Requires=" + fetch_name, "After=" + fetch_name,
            "[Service]", "Type=simple", "User=" + service["user"], "Group=" + service["group"], "UMask=0077",
            "ExecStart=/usr/bin/python3 " + config["currentPath"] + "/native/service-launch.py --config " + config["_file"] + " " + role,
            "Restart=on-failure", "RestartPreventExitStatus=75", "RestartSec=2", "TimeoutStopSec=30", "KillMode=control-group",
            "PrivateTmp=yes", "ProtectSystem=strict", "ProtectHome=yes", "NoNewPrivileges=yes", "PrivateMounts=yes",
            "ReadWritePaths=" + config["baseDirectory"], "[Install]", "WantedBy=multi-user.target"]
        if role == "proxy":
            lines.insert(-2, "AmbientCapabilities=CAP_NET_BIND_SERVICE")
            lines.insert(-2, "CapabilityBoundingSet=CAP_NET_BIND_SERVICE")
        for credential, output in service["credentials"].items():
            require(output in secrets["roles"][role], "missing-service-secret")
            lines.insert(-2, "LoadCredential=" + credential + ":" + str(secret_root / role / output))
        for credential, source in service.get("externalCredentials", {}).items():
            lines.insert(-2, "LoadCredential=" + credential + ":" + source)
        if role == 'subs':
            lines.insert(-2, 'Environment=RUST_LOG=error')
        # Credential directives belong to [Service], never [Install].
        marker = lines.index("[Install]")
        directives = [x for x in lines[marker + 1:] if x.startswith(("LoadCredential=", "Environment="))]
        lines = lines[:marker] + directives + ["[Install]", "WantedBy=multi-user.target"]
        (UNIT_DIRECTORY / name).write_text("\n".join(lines) + "\n")
        installed.append(name)
    sync_directory(UNIT_DIRECTORY)
    command(["/usr/bin/systemctl", "daemon-reload"])
    return installed


def unit(config, role):
    return "subspace-" + config["installation"] + "-" + role + ".service"


def control(config, operation, roles=("proxy", "store", "subs")):
    command(["/usr/bin/systemctl", operation, *[unit(config, role) for role in roles]], timeout=40)


def stopped(config):
    for role in ("store", "subs", "proxy"):
        result = command(["/usr/bin/systemctl", "show", unit(config, role), "--property=MainPID", "--value"])
        require(result.strip() == b"0", "writer-still-active")
