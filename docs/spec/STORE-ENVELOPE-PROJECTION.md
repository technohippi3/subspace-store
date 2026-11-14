# Atomic envelope projection boundary

EnvelopeProjectionStore is a dormant fixed profile over an already open,
caller-owned SQLite database with exactly outbox and records. It shares the
transaction engine with [EnvelopeOutbox](STORE-ENVELOPE-OUTBOX.md), whose public
constructor still admits only outbox. Neither concrete API has a schema flag,
caller SQL callback or borrowed transaction. There is no DDL, path opening,
migration, store_meta, selected-store upgrade or runtime caller.

The new records layout is exactly kind TEXT NOT NULL, key TEXT NOT NULL, value
TEXT NOT NULL and seq INTEGER NOT NULL, with BINARY-collated primary key (kind,key) in that order,
and an ordinary rowid table with no hidden/generated columns. Other application
tables/views, attached/temporary databases and serving-store metadata refuse.
The existing named-file, UTF-8, FULL and WAL/DELETE requirements remain. Protected
file, sidecar, schema and connection custody and exclusive ownership are caller
preconditions; this supplies neither hostile-schema authentication nor an OS lease.

The projection implements the existing generic latest-per-(kind,key) replay rule.
It folds every validated outbox Entry, including the pending local tail. A null
value is a value, not deletion. Each row retains the latest Entry sequence, and
value TEXT is JSON.stringify of that decoded value, matching existing projection
semantics. It is a derived serialization, never original P, a record digest or
receipt evidence. Original v1/v2 payload bytes remain authoritative and untouched.
Legacy numeric/property-order behavior is retained. A legacy key that cannot be
represented losslessly as SQLite UTF-8 TEXT refuses rather than change identity;
the outbox-only codec/profile remains unchanged. Escaped legacy value characters
remain representable in JSON value TEXT.

Every operation validates the complete outbox prefix and all existing projection
rows inside its owned transaction before mutation. Missing, foreign, duplicate,
wrongly typed, wrong-sequence, lossy or differently serialized rows refuse without
repair. Key/value reads use bounded metadata and raw BLOB casts, preventing driver
UTF-8 replacement from authenticating data. Value length must equal its known
derived serialization before materialization. Derived values can expand relative
to original legacy number spellings; no worst-case heap/CPU qualification follows.

Append and observed-prefix reconciliation write exact outbox bytes/markers and
only newly changed latest projection rows in one immediate transaction. Exact
retries and marker-only advancement perform no projection writes. Reconciliation
preserves newer pending values rather than reapply an older acknowledged view.
A second full outbox/projection readback must match before commit; any SQL,
trigger, lock or readback failure refuses success and rolls back the owned active
transaction. Ambiguous commit outcomes need exact retry/readback; failed rollback
fences reuse. Both tables advance together or neither is reported successful.

projected/get return owned frozen values parsed from the known derived serialization
in the same validated history snapshot and explicitly say envelope-projection-only.
Legacy negative zero therefore follows the existing projection's JSON roundtrip
to zero, including nested values; original P and decoded historical Entry values
remain unchanged. Historical acknowledgment is still
bookkeeping, not freshness, authenticated observation or live effect permission.
This primitive performs no backend I/O, typed domain validation, Result/Grant or
pending-owner admission. Generic projection atomicity does not qualify domain
operation atomicity or activation. Governing domain models and native/ownership
evidence remain necessary before controller selection. The selected DurableStore,
Python controller/runner, bootstrap and sales holds remain unchanged.

Actual SQLite tests cover append/reconcile/retry, raw legacy byte custody, malformed
projections, SQL/trigger/busy-commit rollback, WAL/DELETE killed processes, backup
and reopen. These are storage/process-crash observations, not power-loss, complete
restore/checkpoint publication, hostile/concurrent writers, worst-case retained
512-MiB allocation or controller/native parity evidence.
