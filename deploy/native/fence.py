"""Lifetime Linux ownership shared by raw installed entrypoints."""
import fcntl
import os
from pathlib import Path
import stat


def acquire(path, *, exclusive=False, latch=None):
    if latch is not None and os.path.lexists(latch) and not exclusive:
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
        if latch is not None and os.path.lexists(latch) and not exclusive:
            raise RuntimeError("installation maintenance is active")
        os.set_inheritable(fd, True)
        return fd
    except BaseException:
        os.close(fd)
        raise
