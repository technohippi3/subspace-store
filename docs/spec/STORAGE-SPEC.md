# TypeScript storage boundary

This is the first production component of the TypeScript runtime. It is
not a complete store or permission to open sales. Domain records, checkout,
chain observation and broadcast recovery still need their own runtime
implementation and production tests. These lifecycle cases use real
SQLite, filesystem operations and processes, not the independent model.

## Persistence and ownership

`ts/src/storage/` uses Node 24's built-in SQLite and Effect 4 for typed
failures and scoped resource lifetime. Pin these dependencies in the lock
file and qualify runtime updates through the same tests. The Node SQLite
API is still marked active development; release packaging must pin a
qualified Node version. Tests currently run on Node 24.14.0 locally and
the same pinned version in CI. Full Node declarations replace the earlier handwritten test
API declarations.

Before reading the journal or opening SQLite, acquire the same canonical
`<database>.lock` as the Python store. On Linux, `/usr/bin/flock` acquires
through an inherited descriptor, and the Node process retains that open
file description after the helper exits. Closing it or process death
releases ownership. There is no resident lock helper or stale-PID cleanup.
The lock file remains. SQLite and this ownership file belong on a local
filesystem. The installer must check the util-linux flock dependency.
[Linux flock semantics](https://man7.org/linux/man-pages/man2/flock.2.html)
explain descriptor inheritance and lifetime.

One SQLite transaction updates records and a durable outbox entry. The
outbox records every transition's sequence, instance identity, changes,
preceding digest and SHA-256 digest. Individual records retain their latest
sequence. A caller must not expose an address, final cancellation or send
intent until the corresponding receipt is acknowledged. That receipt is a
historical durability marker, not a live availability check. Application
broadcast handlers must call `confirm(seq)` immediately before the RPC,
as well as applying their financial and controller guards. The storage
component does not itself authorize a broadcast. The component
returns pending receipts during a journal outage; that is not authorization
for any external effect. Operator diagnostics retain the journal failure. This backend interface is
synchronous; a Promise-returning adapter is rejected, not mistaken for an
acknowledgment. A future network backend requires an async Effect flow.

The initial journal backend is an existing dedicated directory on storage
that survives the host. Each entry is a separate immutable JSON object. A
complete file is fsynced, published without overwriting another entry,
directory-synced and read back before acknowledgment. Incomplete staging
files cannot become entries. Retries require the same sequence, identity
and digest. Startup validates the complete sequence and digest chain; it
refuses corruption, gaps, a foreign journal or missing acknowledged
history. Digests detect accidental corruption, not a malicious operator
rewriting all history. This is a filesystem backend, not an object-store
integration; qualifying off-host deployment remains required.

SQLite acknowledgments are a contiguous prefix. Startup reconciles saved
outbox entries with the journal before retrying unacknowledged writes.
Before startup adopts linked entries, it repeats the directory sync: a
crash may have occurred between publication and that durability boundary.
If the sync fails, no acknowledgment is adopted. A journal ahead of a
coherent database snapshot is replayed; a lost answer
after publication does not create a second entry. Projection replay is
atomic. Schema version 1 is explicit; unknown schemas, including the Python
database, are refused rather than implicitly migrated.

## Restore and controller boundary

A missing or empty database cannot silently start over journal history.
Explicit restore writes a separate working database and atomically publishes
it only after replay and checkpointing. It never overwrites a serving
path. A killed restore can reuse its working file, but cannot supplement
the recovery set with local history beyond the journal. Restored metadata
requires reconciliation; the future application must keep admission paused
until its payment/chain recovery is checked. Storage-level record replay
alone does not establish the buyer's payment-history marker or on-chain
readiness.

Records include names, orders, historical addresses, certificates, issued
handles and future accounting records. This generic persistence component
checks JSON/envelope integrity; the application must add each domain
schema and authorization before writing it. Restoring records is not a
substitute for reconciling subs and chain issuance state.

The Python controller can back up this SQLite database through its existing
read-only connection. The runner's snapshot journal-position adapter reads
the TypeScript outbox's acknowledged prefix, while retaining the baseline
JSON-lines reader for Python stores. It does not reimplement the new
journal codec. Whole-runner restore and registry HTTP integration are still
stage 2 work; the new storage tests do not claim the operator gate passed.

## Cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| Z1 | a fresh owned SQLite store and journal | commit several records, close, reopen and update | records and acknowledgment survive; sequence advances once; record and journal agree |
| Z2 | an open store whose journal becomes unavailable | commit, inspect receipt, confirm an older acknowledged entry, restart with storage available | local transaction remains pending, external acknowledgment false with a diagnostic; an unreachable journal fails live confirmation even for an older acknowledgment; restart retries and acknowledges once |
| Z3 | an append published but its answer lost, or a process killed before updating SQLite's acknowledgment | retry or restart, then commit again | first entry adopted once and the next sequence is used; same historical payment address retained |
| Z4 | a store with journal history | damage a checksum, remove entries or select another journal | startup refuses before replay; no empty-history fallback or replacement of good state |
| Z5 | acknowledged name, order, certificate and committed-handle records | normal empty start, then explicit restore | normal start refuses; explicit restore retains records and monotonic sequence, sets reconciliation-required metadata and refuses overwrite |
| Z6 | a batch whose later record hits a SQLite constraint failure | commit the batch | records and outbox roll back together, journal unchanged |
| Z7 | a Python-created SQLite backup behind the TypeScript journal | reopen the backup with the current journal | later state replayed, no second journal entry; Python snapshot reader reports the acknowledged position |
| Z8 | restore killed during its replay transaction | inspect serving path, then retry restore | no partial serving database; retry completes and remains reconciliation-required |
| Z9 | crash after linking a fsynced journal file but before directory sync | startup adoption first fails its directory sync, then retries successfully | failed sync adopts no acknowledgment; successful sync acknowledges the original entry once |

H12 additionally runs against the TypeScript storage component: real
Python and TypeScript owners contend in both directions, before journal
construction. Effect scope failure/interruption, normal close and process
death release ownership. These tests do not cover deployment maintenance
of controller/refund broadcasts, which remains a separate requirement.

References: [Node 24.14 SQLite](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html)
and [Effect 4](https://effect.website/docs/v4/onboarding).
