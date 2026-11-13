"""Lifetime Linux ownership shared by raw installed entrypoints."""
import fcntl
import json
import os
from pathlib import Path
import stat


def recovery_allowed(marker):
    fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_uid not in (0, os.geteuid()) or info.st_size > 65536:
            return False
        raw = os.read(fd, 65537)
        if len(raw) > 65536:
            return False
        value = json.loads(raw)
        named = os.stat(marker, follow_symlinks=False)
        return (named.st_dev, named.st_ino) == (info.st_dev, info.st_ino) and isinstance(value, dict) and type(value.get("version")) is int and value["version"] == 1 and value.get("applicationPath") == str(Path(__file__).resolve().parents[1])
    finally:
        os.close(fd)


def acquire(path, *, exclusive=False, latch=None, recovery=False):
    marker = Path(path).parent / "recovery.json"
    def latched():
        return (latch is not None and os.path.lexists(latch)) or (os.path.lexists(marker) and (not recovery or not recovery_allowed(marker)))
    if not exclusive and latched():
        raise RuntimeError("installation maintenance is active")
    fd = os.open(path, (os.O_RDWR if exclusive else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_uid not in (0, os.geteuid()):
            raise RuntimeError("invalid installation ownership file")
        fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        named = os.stat(path, follow_symlinks=False)
        if (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino):
            raise RuntimeError("installation ownership file changed")
        if not exclusive and latched():
            raise RuntimeError("installation maintenance is active")
        os.set_inheritable(fd, True)
        return fd
    except BaseException:
        os.close(fd)
        raise


class InstallationBusy(RuntimeError):
    pass


def configured(config, *, recovery=False):
    """Version 2 requires the package-created fence; legacy fixtures opt in."""
    path = config.get("maintenance_lock")
    if path is None and config.get("version") != 2:
        return None
    if not isinstance(path, str) or not Path(path).is_absolute() or "\0" in path or len(path) > 4096:
        raise InstallationBusy("an explicit installation maintenance lock is required")
    try:
        return acquire(path, latch=str(Path(path).parent / "maintenance.json"), recovery=recovery)
    except Exception:
        raise InstallationBusy("installation maintenance is active or ownership unavailable") from None


def attach(owner, fd):
    """Retain ownership through the object's existing close lifecycle."""
    if fd is None:
        return owner
    original = owner.close
    held = fd

    def close():
        nonlocal held
        try:
            original()
        finally:
            if held is not None:
                os.close(held)
                held = None

    owner.close = close
    return owner
