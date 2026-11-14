# Isolated exact-byte SQLite outbox

EnvelopeOutbox is an unwired storage primitive for an already open, caller-owned,
outbox-only SQLite database. It consumes the [envelope codec](STORE-JOURNAL-CODEC.md).
It neither opens paths nor creates/migrates schema. It rejects databases containing
store_meta, records, other application tables/views or attached/temporary databases.
The selected DurableStore and its replay, projection, checkpoint/restore and
runtime paths remain unchanged. This is not a supported new store profile.
The separate dormant [projection profile](STORE-ENVELOPE-PROJECTION.md) shares
the internal transaction engine and qualifies generic outbox/records atomicity;
it does not relax this outbox-only constructor's schema guard.

The caller must establish exclusive ownership, protected file/sidecar/connection
custody and safe opening before construction and throughout use. No OS lease,
untrusted-stage inspection or hostile SQLite-schema authentication is supplied.
The primitive requires a named persistent main database, UTF-8, synchronous FULL
and WAL or DELETE journaling, with exactly the existing seq/payload/acknowledged
columns and no hidden/generated columns. It refuses nested caller
transactions and owns only each transaction it begins. It does not mutate pragmas,
close the connection, publish a database or authorize activation/external effects.

Payload TEXT is read through cast(payload as blob), after bounded metadata checks,
so the driver cannot silently replace malformed UTF-8 before validation. BLOB and
invalid/non-lossless TEXT, gaps, identity/hash/floor failures, bad marker types and
nonprefix historical markers refuse. Record/head/prefix limits match the codec.
Every result retains exact original bytes alongside immutable decoded data. Local
or observed payloads remove no whitespace or LF. Accepted bytes and historical
markers cannot disappear, be rewritten or regress within an instance.

Append validates the full history and prospective prefix before inserting exact P
as TEXT with a pending marker in one immediate transaction. New records require
v2. Exact existing v1/v2 retries leave payload and marker unchanged. Reconcile
accepts a caller-supplied observed prefix, checks complete structural/byte identity
before mutation, imports original bytes, advances historical markers and retains
any local pending tail. An absent historically marked entry or same logical hash
with differing bytes refuses. No existing payload is rewritten as acknowledgment
bookkeeping. A second full in-transaction scan must match the intended rows before
commit, detecting trigger-induced changes; failures roll back the owned transaction.
A failed commit/rollback can remain an unknown outcome: retain exact requests and
reinspect under custody rather than infer absence. A rollback failure fences reuse.

The historical marker is neither authentication of the supplied observation nor
live off-host confirmation. The caller must establish provenance/freshness through
the qualified backend and later store/domain protocol. A historical true bit never
permits a send. This primitive performs no backend I/O or domain/projection write.
Atomic domain projections and outbox records must be integrated under a separately
qualified transaction interface before selection; separate calls here do not supply
that future atomicity. The isolated-profile guard must be deliberately reconciled
with a reviewed store schema/profile at that point, not bypassed by a config flag.

Historical lookup reads validated Entry changes through the codec instead of JSON
SQL over framed payloads, retaining false, zero, null, arrays and objects. It is a
derived lookup, not a protocol/domain projection validator. Head metadata reports
both logical hash and plaintext digest plus historical marker head. It is not a
checkpoint image, local/remote coherence proof or recovery-completion permission.

Tests use real file-backed SQLite for byte fidelity, reconciliation, pending/history
lookup, malformed rows, SQL failures/readback changes, reopen, WAL backup and child
process termination around transactions. These are process-crash/SQLite boundary
observations, not power-loss, worst-case 512-MiB allocation, hostile/concurrent
writers, OS ownership, complete restore, domain/native or buyer qualification.
Python removal, bootstrap and effectful controller selection remain later gates.
