# Package fixture progress diagnostics

The installed-host integration uses one shared Python fixture under the existing
900000-ms subprocess deadline. A timeout can reject that shared Promise and fail
eight dependent cases. Previously the parent exported receipts only after success;
the failing log could identify a test method without its last operation. This
adds diagnostic evidence, not a cause claim or a change to fixture assertions,
deadlines, O149, runtime selection or the Python reference implementation.

Only the platform child receives SUBSPACE_PACKAGE_PROGRESS_FILE. The fixture
records fixed phase and command-category labels, monotonic elapsed milliseconds,
sequence and start/complete/error/state events. Schema-two transition markers
identify the major installation, abort-history and checkpoint stages. Guest state
is the last observed QEMU process running/stopped state at an instrumented call;
it is not a new guest probe or proof of current service health. Arguments, command
output, exception messages, environment, host paths and credentials are excluded.
The shared checked-in allowlist constrains labels in both writer and collector.

The parent creates a fresh mode-0600 file exclusively. The opt-in writer is
thread-serialized and bounded to 16384 records/four MiB, with a limit marker.
It opens without following links or blocking on a FIFO, requires a regular file
whose size matches its own counted bytes, and admits the entire next line against
the actual file size. A partial write is counted and permanently disables further
recording. Existing nonempty or unexpectedly changed files are not appended.
An interrupted last line may be partial. I/O failures stop recording without
replacing fixture behavior. These diagnostics are not a durable data journal.

The parent collects in finally before its existing exit cleanup removes the
temporary deployment. It accepts only bounded regular files without following
symlinks and exports validated known fields/labels, never raw input. Unknown,
malformed or nonmonotonic records are counted/discarded; partial, bounded and
unavailable sources are explicit. A successful fixture requires valid untruncated
progress and the recorder's fixed normal-interpreter-exit marker. The normalExit
field distinguishes that from a valid-looking but unfinished prefix. Reporting
failure fails a successful call; it cannot replace
an existing primary fixture error. Outcome records the wrapped fixture's result.

SUBSPACE_PACKAGE_DIAGNOSTICS_DIRECTORY selects the external diagnostic directory.
CI sets it below runner.temp and uploads only the sanitized platform JSON reports
even when the suite fails, retaining them for seven days. Raw serial consoles,
service journals, temporary directories, images, keys and release payloads are
not included. A job killed before collection or a retention-write failure may
still leave no artifact; the collector logs that limitation. It does not extend
the child deadline, retry work, repair a fixture or guarantee guest cleanup.

Focused tests run an actual Python recorder child, terminate it after a ready
handshake and short deadline, and verify retained evidence after source cleanup.
They exercise nested exceptions, sensitive argument/error exclusion, invalid and
partial records, file/record limits, nonregular files and primary-error preservation.
Writer controls cover preexisting targets, actual short writes and silent I/O failure.
The ordinary full package suite also executes the instrumented VM path. Neither
these checks nor a later passing run establish why an earlier hosted run stalled.
Use the next failed run's phase history to narrow a separate repair if required.
