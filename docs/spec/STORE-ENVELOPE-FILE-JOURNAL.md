# Dormant local envelope file journal

`ts/src/storage/envelope-file-journal.ts` implements a synchronous local file
boundary for [the proposed journal format](STORE-OPERATION-JOURNAL.md). It consumes
the [envelope-only codec](STORE-JOURNAL-CODEC.md). It is separate from the selected
Journal interface and has no runtime caller. Existing FileJournal, SshJournal,
SQLite/outbox, checkpoint, restore, operation APIs and Python remain unchanged.

The caller must hold exclusive ownership and protect the directory and its
ancestors throughout use. This class acquires no process lock and cannot authorize
a second writer or defend against an actor replacing its directory. Tests of
publication collisions are failure tests, not permission for concurrent writers.
The selected DurableStore's database lease is not automatically extended to this
unwired class. OS ownership integration needs separate lifecycle qualification.

The directory must already exist and cannot itself be a symlink. Numbered objects
are regular files opened without following symlinks, with bounded reads before
parsing. Unknown names, gaps, malformed frames, changed lengths, invalid chains,
floors, downgrades and the codec's byte/head limits refuse. Ignored `.pending-`
names are unpublished debris, never history. The class does not delete crashed
pending files or silently repair histories. Envelope validation is not domain,
configuration/capability, operation, pending-owner or native-evidence validation.

append accepts exact payload P bytes, copies/revalidates them and permits new v2
writes only after structural prefix inspection and sync of every adopted prior
file. This includes an existing prefix found during construction and any later
valid extension; visible bytes alone are not proof of durable file contents.
It writes P plus exactly one LF
to a mode-0600 exclusive temporary file, syncs that file, hard-links it to the
numbered destination without replacement, syncs the directory and re-reads the
complete structural prefix before returning. An existing destination must have
identical payload bytes and is itself synced before directory sync. A differing
or unreadable destination refuses without overwriting it. Retained prefix bytes
must remain identical and cannot disappear, even if a replacement has the same
embedded logical hash. Successful calls remove their own temporary name; earlier
crash debris remains untouched. Failed calls can leave a published file requiring
an exact retry.

read and existing-sequence retry sync each valid file and then the directory
before returning a frozen array of immutable envelope records. This also covers a
previous process killed after linking but before directory sync. Construction
only inspects/pins a prefix; it is not a durability return. A valid extension may
be adopted when the caller has re-established exclusive custody. Legacy payloads
retain their original whitespace, duplicates and exponent forms; their physical
files are never rewritten. An optional physical final LF is stripped only by the
codec's file reader. Same logical hash with different payload bytes is a failed
retry. No decoded Entry is reserialized as byte evidence.

Sync, publication, readback and cleanup failures throw. The caller cannot infer
absence from an exception: the destination may already exist durably. It must
retain the exact request and retry/reconcile under its ownership protocol.
Returning from this class proves only its local structural file boundary under
protected custody. It is not an off-host acknowledgment, authenticated format
activation, SQLite transaction result or authority to perform an external effect.

Tests exercise actual local files, modes, immutable publication, byte-preserving
legacy transition/retry, retained-prefix rewrites, malformed/sparse/special files,
sync ordering/failure and exact/nonidentical collisions. Separate child processes
are killed before linking, after linking and around directory sync, then recover
the same bytes. Fault wrappers execute real filesystem calls; they do not simulate
an ownership lease. These tests establish observed syscall order and process-crash
behavior, not power-loss guarantees, every filesystem, worst-case resource use,
host restoration or selected-store integration. Those gates, domain models and
native parity must accompany later selection before Python removal. Bootstrap
remains a separate decision and PR.
