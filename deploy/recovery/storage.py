"""Bounded immutable storage for the restricted SSH recovery protocol."""
import base64
import binascii
import hashlib
import os
import re
import secrets
import stat

MAX_OBJECT = 1024 * 1024
MAX_REQUEST = 4 * 1024 * 1024
MAX_SEQUENCE = 1_000_000
MAX_PAGE = 8192
SHA = re.compile(r"[0-9a-f]{64}\Z")
SAFE_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\Z")
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class Refused(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code="invalid-request"):
    if not condition:
        raise Refused(code)


def exact(value, fields):
    require(isinstance(value, dict) and set(value) == set(fields.split()))


def integer(value, minimum=0, maximum=MAX_SEQUENCE):
    require(type(value) is int and minimum <= value <= maximum)
    return value


def digest(value):
    require(isinstance(value, str) and SHA.fullmatch(value))
    return value


def decode(value, sha):
    digest(sha)
    require(isinstance(value, str) and len(value) <= 4 * ((MAX_OBJECT + 2) // 3))
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise Refused("invalid-request") from None
    require(len(data) <= MAX_OBJECT and hashlib.sha256(data).hexdigest() == sha,
            "digest-mismatch")
    return data


def open_root(path):
    require(isinstance(path, str) and path.startswith("/") and "\0" not in path)
    parts = path.split("/")[1:]
    require(parts and all(p and p not in (".", "..") for p in parts))
    fd = os.open("/", DIRECTORY)
    try:
        for part in parts:
            child = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        require(info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
                "unsafe-directory")
        return fd
    except BaseException:
        os.close(fd)
        raise


def directory(parent, name):
    require(SAFE_ID.fullmatch(name))
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
        os.fsync(parent)
    except FileExistsError:
        pass
    fd = os.open(name, DIRECTORY, dir_fd=parent)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
        os.close(fd)
        raise Refused("unsafe-directory")
    return fd


def read(parent, name, maximum=MAX_OBJECT):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC |
                 os.O_NONBLOCK, dir_fd=parent)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0 and
                info.st_size <= maximum, "unsafe-object")
        chunks = []
        total = 0
        while True:
            data = os.read(fd, min(65536, maximum + 1 - total))
            if not data:
                break
            chunks.append(data)
            total += len(data)
            require(total <= maximum, "oversize-object")
        os.fsync(fd)
        return b"".join(chunks)
    finally:
        os.close(fd)


def publish(parent, name, data):
    """No overwrite. Both exact retry and first publication prove durability."""
    temporary = ".pending-" + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                 os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
    try:
        remaining = memoryview(data)
        while remaining:
            n = os.write(fd, remaining)
            require(n > 0, "storage-unavailable")
            remaining = remaining[n:]
        os.fsync(fd)
        try:
            os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent,
                    follow_symlinks=False)
        except FileExistsError:
            require(read(parent, name) == data, "immutable-conflict")
    finally:
        os.close(fd)
        os.unlink(temporary, dir_fd=parent)
    os.fsync(parent)
    require(read(parent, name) == data, "readback-mismatch")


def entries(parent):
    values = []
    with os.scandir(parent) as objects:
        for item in objects:
            if item.name.startswith(".pending-"):
                continue
            require(len(values) < MAX_SEQUENCE and
                    re.fullmatch(r"[0-9]{16}\.json", item.name) and
                    item.is_file(follow_symlinks=False), "journal-corrupt")
            values.append(item.name)
    values.sort()
    require(all(name == filename(i + 1) for i, name in enumerate(values)),
            "journal-gap")
    return values


def filename(sequence):
    return f"{sequence:016d}.json"
