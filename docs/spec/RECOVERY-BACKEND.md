# Offhost recovery backend wiring

The packaged native profile uses the encrypted SSH recovery client for both
journals and coordinated snapshots. This document specifies its runtime
composition. It adds no provider, financial policy or sending permission.
The existing Python owner-only baseline and version 1 TypeScript fixtures
retain their FileJournal protocol.

Version 2 TypeScript configuration may contain `recoveryBackend`, exactly
`{version: 1, node, client, config}`. The three values are distinct absolute
paths. They refer to the bundled Node binary, bundled client entrypoint and a
protected recovery configuration file. The runner names the same object
`recovery_backend`; it requires version 2, the explicit TypeScript store and
an absolute `controller.snapshot_dir`. A present malformed or inaccessible
reference fails closed. No error chooses a local journal. The first packaged
production profile requires this field on both sides; its credentials and
installation lifecycle are specified by that profile.

The recovery configuration contains installation identity and SSH/encryption
credential file references. Neither application configuration nor journals
contain private credential bytes. A normal service uses its own credential
references. Offline maintenance generates a separate private maintenance
view. Within that view, the TypeScript parent and Python recovery child must
name identical version, Node, client and recovery-config references. A
one-sided or different reference refuses before controller recovery. A
stopped service unit's private credential mount is never reused for this
view.

The store journal validates each live decrypted entry's raw SHA-256,
sequence, codec hash chain and store identity. The controller journal validates
its full decrypted sequence and raw hashes. Replay is bounded to one million
entries and 512 MiB; a head change during full replay refuses. Previously read
entries are bookkeeping for append retries, never an authorization cache.
Read, head and immutable retry acknowledgments require durable remote
publication before the client returns. An unavailable remote refuses startup,
quotes and normal or refund sends through the existing live journal guards.

The runner's store snapshot reader compares the SQLite outbox's complete
acknowledged sequence and exact payload bytes with the decrypted remote store
prefix. Its normal live position additionally requires equal heads. A
coordinated snapshot backs up both databases while subs stays stopped. The
remote backups use DELETE journal mode so their readonly validation cannot
introduce WAL/SHM sidecars. Their complete staged files and directories are
fsynced before upload. It then compares the copied registry outbox to its acknowledged remote prefix
and the copied controller's entire batch projection to the latest per-batch
records in the claimed decrypted controller prefix. A same-count different
history is insufficient. An ordinary checkpoint can copy an earlier store
prefix while the running store records later unrelated observations; it
claims only the copied prefix. Exclusive offline maintenance additionally
requires equal live heads because all its writers are stopped.

The controller numbers snapshots from the live remote inventory. Local
checkpoint staging is private and disposable; it is never a recovery
catalogue or acknowledgement. After copied-file validation the controller
uploads the encrypted snapshot and receives verified remote acknowledgement
while subs remains stopped. Only then may it start subs, return the
checkpoint and promote the batch. An upload failure leaves the batch proved
and subs stopped. The package's stop/start commands provide the operating
system fence against a competing subs restart.

Restore lists the remote snapshot inventory and materializes the chosen
acknowledged set into a fresh private directory on every attempt. It validates
both copied databases against the snapshot's authenticated remote prefixes
before copying subs data. A local cached snapshot cannot satisfy a remote
outage. Existing ambiguous subs staging directories are preserved; a new
invocation stages only in its own newly created directory. Existing
nonempty mismatching serving data is never overwritten. The existing
read-only store inventory, binding checks and unknown-transaction quarantine
remain mandatory. Materializing a snapshot grants no send permission and
opens no ordinary listener.

The TypeScript parent confirms a reconciliation receipt against the entire
live decrypted controller prefix, then rereads its head. The claimed final
row must be the exact `store_reconciliation` statement with the expected
canonical proof hash at the acknowledged position. A valid final row cannot
hide a corrupted earlier entry or a changed prefix. Local JSON-lines proof
confirmation applies only when neither side configures the backend.

These are runtime lifecycle cases. Their controlled-reply composition tests
execute the shipped store, controller and runner, but do not claim native
chain, systemd, mainnet transaction or buyer acceptance coverage. Encrypted
client/helper and OpenSSH qualifications remain separately identified.

| Case | Required executable behavior |
| --- | --- |
| O154 | Explicit backend selection rejects malformed/version-1 references and refuses unavailable remote startup/restore despite a valid local journal, before listeners or publication. |
| O155 | Live full-prefix checks reject earlier corruption, same-count store payload substitution, unacknowledged controller batch state and changed reconciliation receipt heads. |
| O156 | Actual controller checkpoint keeps subs stopped through remote acknowledgement; upload failure leaves proved state, and a later acknowledged retry alone promotes it. |
| O157 | Actual host-loss runner restore requires fresh remote materialization, preserves ambiguous stages and unknown-arm quarantine, and cannot invoke a send. |
| O158 | Store-owned reconciliation requires identical explicit backend references in its temporary parent/child maintenance view; missing or differing references refuse. |
| O159 | Version 1 retains its original FileJournal history and rejects an implicit backend protocol change. |
