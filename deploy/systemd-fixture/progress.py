"""Opt-in fixed-label diagnostics. Never record arguments, output or secrets."""
from contextlib import contextmanager
from functools import wraps
import atexit
import json
import os
from pathlib import Path
import threading
import stat
import time

PHASES = frozenset(json.loads(Path(__file__).with_name('progress-phases.json').read_text()))
MAX_RECORDS = 16384
MAX_BYTES = 4 * 1024 * 1024
_started = time.monotonic()
_lock = threading.Lock()
_sequence = 0
_bytes = 0
_limited = False
_disabled = False


def event(kind, label):
    global _sequence, _bytes, _limited, _disabled
    target = os.environ.get('SUBSPACE_PACKAGE_PROGRESS_FILE')
    if not target:
        return
    if label not in PHASES or kind not in ('start', 'complete', 'error', 'state'):
        raise ValueError('unknown fixture progress label')
    with _lock:
        if _limited or _disabled:
            return
        if _sequence >= MAX_RECORDS - 1 or _bytes > MAX_BYTES - 512:
            kind, label = 'limit', 'diagnostics.limit'
            _limited = True
        record = dict(version=1, sequence=_sequence + 1, elapsedMs=int((time.monotonic() - _started) * 1000),
                      event=kind, phase=label)
        raw = (json.dumps(record, separators=(',', ':')) + '\n').encode()
        # Diagnostic failure must not replace a fixture assertion or change its
        # flow. Successful runs require a usable trace in the parent collector.
        try:
            fd = os.open(target, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NONBLOCK | os.O_NOFOLLOW, 0o600)
            try:
                metadata = os.fstat(fd)
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != _bytes or metadata.st_size + len(raw) > MAX_BYTES:
                    _disabled = True
                    return
                written = os.write(fd, raw)
                _bytes += written
                if written != len(raw):
                    _disabled = True
                    return
            finally:
                os.close(fd)
        except OSError:
            _disabled = True
            return
        _sequence += 1


@contextmanager
def phase(label):
    event('start', label)
    try:
        yield
    except BaseException:
        event('error', label)
        raise
    else:
        event('complete', label)


def traced(label):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            with phase(label):
                return function(*args, **kwargs)
        return wrapped
    return decorate


def command(arguments):
    program = Path(str(arguments[0])).name
    label = 'command.' + program
    return phase(label if label in PHASES else 'command.other')


def guest_state(process):
    event('state', 'guest.running' if process and process.poll() is None else 'guest.stopped')


atexit.register(event, 'state', 'diagnostics.finished')
