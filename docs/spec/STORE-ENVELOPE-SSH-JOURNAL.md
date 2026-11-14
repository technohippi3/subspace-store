# Dormant exact-byte SSH journal

EnvelopeSshJournal is a separate synchronous byte-storage adapter over the existing
RecoveryCommand, encrypted client and restricted helper. It consumes the
[envelope-only codec](STORE-JOURNAL-CODEC.md) and implements the transport boundary
of [the proposed store format](STORE-OPERATION-JOURNAL.md). Selected SshJournal,
backendStorage, DurableStore and the product runtime do not select it. The local
[file adapter](STORE-ENVELOPE-FILE-JOURNAL.md) remains a separate dormant slice.

The caller must hold exclusive ownership and protect the client, configuration,
keys and remote immutable storage throughout use. This class acquires no process
lease and does not support concurrent authority writers or a hostile key holder.
Returning structural off-host bytes is not operation/domain authorization,
format activation, live store/local coherence or permission for an external effect.

Each read obtains the complete bounded prefix, requiring exact response fields,
canonical base64, original plaintext SHA-256, encrypted remoteSha256, sequence,
stable paginated head and structural UUID/hash/floor lineage. A final fresh head
must match the last plaintext and encrypted receipt, including nulls at head zero.
The 8192-entry/16-MiB page, 16-MiB record, 512-MiB prefix and 1000000-head bounds
remain effective. RecoveryCommand keeps its existing 24-MiB message and 30-second
subprocess limits. Original payloads retain every byte; remote input strips no LF.
Returned arrays/records are immutable and byte access returns owned copies.

The instance pins accepted payloads and remote receipt identities. Disappearing,
rewritten or re-encrypted retained history refuses, even when the logical embedded
hash agrees. A valid extension may be adopted after the caller has re-established
exclusive custody. Failed reads throw without returning a cached successful view.
These are observations under protected immutable custody, not a linearizability
proof against another writer mutating pages already read.

Append accepts exact P bytes, validates a fresh complete prefix before sending,
and permits only new v2 writes. Existing v1 retries require the original exact
payload; they do not reconstruct or rewrite it. A matching historical retry still
calls the shipped encrypted append boundary and confirms fresh history afterward.
After checking the acknowledgment, the adapter re-reads the complete prefix and
head, requires the original prefix unchanged and exactly the expected one-entry
extension or historical retry, then compares the target payload and encrypted
receipt. Exceptions remain unknown publication outcomes; retain the exact request
and reconcile/retry under ownership, without inferring absence or no effect.

The J1/J2 encryption/chunk formats and helper protocol remain unchanged. Plaintext
recordDigest and encrypted remoteSha256 stay distinct. Domain/protocol projections,
pending-owner/native evidence, SQLite/outbox, checkpoint/restore and trusted reader
compatibility remain unimplemented prerequisites before selection. A full retained
prefix can consume substantial heap; enforcing byte limits does not qualify
worst-case CPU/heap or availability. Python removal and bootstrap remain later gates.

Tests use deterministic malformed-response controls and real pinned OpenSSH with
the shipped client/helper for exact legacy/v2 publication, chunked data, retries,
immutable conflict, host-pin rejection and outage. They establish the exercised
storage/transport boundary, not complete controller/native, host restore, power-loss,
ownership/lifecycle or buyer qualification. Existing selected consumers and their
case coverage remain unchanged.

Focused controls exercise page count, early page termination, record/page byte
limits, response/head mutations and floor lineage. The codec separately exercises
its streaming 512-MiB bound. This slice does not run a full retained 512-MiB SSH
prefix or qualify its aggregate allocation at that bound.
