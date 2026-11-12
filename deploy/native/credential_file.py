"""Protected ordinary files and verified systemd255 credential mounts."""
import os
from pathlib import Path
import re
import stat
from common import require


def protected(path, maximum=16384):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode), "unsafe-credential-type")
        require(info.st_nlink == 1, "unsafe-credential-links")
        restricted = not info.st_mode & 0o077
        directory = os.environ.get("CREDENTIALS_DIRECTORY")
        if not restricted and directory and re.fullmatch(r"/run/credentials/[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,240}\.service", directory):
            parent = Path(path).parent
            directory_info = parent.lstat()
            restricted = (str(parent) == directory == os.path.realpath(directory) and
                stat.S_ISDIR(directory_info.st_mode) and not stat.S_ISLNK(directory_info.st_mode) and
                directory_info.st_uid == directory_info.st_gid == 0 and directory_info.st_mode & 0o777 == 0o550 and
                info.st_uid == info.st_gid == 0 and info.st_mode & 0o777 == 0o440 and
                bool(os.statvfs(parent).f_flag & os.ST_RDONLY))
        require(restricted, "unsafe-credential-permissions")
        require(info.st_size <= maximum, "oversize-credential")
        with os.fdopen(fd, "rb", closefd=False) as file:
            value = file.read(maximum + 1)
        require(len(value) <= maximum, "oversize-credential")
        return value
    finally:
        os.close(fd)


