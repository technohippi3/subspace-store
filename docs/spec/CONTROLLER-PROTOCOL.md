# Mandatory controller protocol and abort continuation

This amendment closes the older-reader and surviving-paid-member gaps found
in `7d43c77`. It extends `CONTROLLER-AVAILABILITY.md`. It changes lifecycle
compatibility, not payment policy.

## Acknowledged protocol boundary

Before the first abort marker, both controllers acknowledge a mandatory
controller protocol record. Its bytes are `SSCJ3 ` followed by compact JSON
with sorted fields `kind`, `requires`, `seq`, `version`. The values are
`controller_protocol`, `["preparation_abort_v1"]`, the next journal sequence,
and integer `3`. Python and TypeScript emit identical bytes. The frame is
one append-only record; no earlier record is rewritten, removed or renumbered.
Ordinary records retain their existing JSON envelope.

Legacy JSON-only readers fail parsing the frame rather than ignoring an
unknown event. This applies to the file journal and the decrypted bytes of
the encrypted remote stream. An older database cannot hide the boundary
while the acknowledged journal prefix survives. Unsupported versions,
unknown required features, duplicate fields and unframed protocol records
refuse in current readers too. This contract does not authorize restoring
an older off-host journal prefix or bypassing the controller with native RPC.

Abort acknowledges and reads back this boundary before its abort marker or
pending-clear request. A lost journal acknowledgment cannot permit the native
operation; a later acknowledged read may establish the same immutable record.
A restart does not append a second floor when the first survived. If existing
`7d43c77` history already contains an abort without framing, current controller
startup adds and acknowledges the floor before external effects. TypeScript
may still record local interrupted-send uncertainty during a journal outage;
each effect-bearing preparation, issuance and release path rechecks the upgrade
when history becomes available. Unavailable history cannot authorize native
work or pending clear. Read-only diagnostics and local safety recording grant
no exception to that rule.

Both current file/remote journal readers and file and remote store-reconciliation
confirmation understand mandatory records. The installed maintenance checkpoint
reader was missed in the initial amendment. The checkpoint repair now loads the
pure decoder from the staged, signature-verified target package, without importing
the controller or initializing its database. It validates every framed record
while retaining digest, contiguous-sequence, stable bounded-prefix and latest
database agreement checks. Unknown protocols refuse before publishing a snapshot.
Sequence numbers and checkpoint positions count the framed record. There is
no JSON-only mirror fallback. A diagnostic reader knowing the frame may show
history; an effect-bearing old controller remains excluded.

## Package compatibility

Signed package metadata now declares `controllerJournal:3`. All other schema
fields remain unchanged. The current installer explicitly permits the
one-way `controllerJournal:2` to `3` transition, subject to existing signed
release ancestry and readiness gates. It never grants the reverse transition.
The current verifier rejects an older signed schema-2 release. Older
installers reject a schema-3 installed receipt against a schema-2 target
before staging or service changes. The raw journal frame independently blocks
old controllers when launched directly or against an older controller DB.

The bootstrap installer is separately provisioned; applying a payload does not
replace it. An unchanged schema-2 bootstrap also rejects a schema-3 target with
`unsupported-release-schema` before staging. Before the first 2-to-3 update,
provision the reviewed schema-3 bootstrap and all sibling modules through the
independently trusted bootstrap path. Select that explicit path for manual and
Alchemy operations. Its dry-run must accept the signed successor and its ancestry
before maintenance begins. Never weaken the old verifier or edit an installed
receipt to force compatibility. `deploy/OPERATIONS.md` describes the handoff.

These are source and test-fixture results. No new signed production package,
deployment, rollback or installation acceptance is established by this change.

## Paid-order continuation

An abort retires its whole controller batch without changing the orders'
store status. A still-paid, eligible converted member can be frozen under a
new batch ID. The ordinary preparation path must restage the exact surviving
recipient, exclude the cancelled member, make one local commitment, prove,
checkpoint, issue and reach verified certificate/relay delivery. The original
recipient request remains authoritative. The cancelled member stays cancelled.

The extended native harness freezes both a later-cancelled order and a paid
survivor, aborts that batch, and carries that same survivor through the full
fresh-batch path. It independently verifies the downloaded certificate with
libveritas and the survivor's original script. It then retains the previous
unknown-request availability scenario. Those are local regtest results with
exact source hashes, not independently executed native or phone acceptance.

## Review and regression scope

A combined coordinator review of `a2d0afb..7d43c77` traced native-root reads,
abort history, known-unsent retirement, sent-batch exceptions and restore
entrypoints. It confirmed both supplied gaps. This is the implementing
coordinator's review, not independent approval of those 56 paths or the
accumulated PR. The existing root guard still assumes a sole native writer.
Unknown native-request clearance, post-arm recovery and durable prover
submission ownership remain open.

Regression tests export unchanged historical repository sources into
disposable non-Git directories. Python controllers at `c63e96b`, `a2d0afb`,
`8bb7312` and `7d43c77` open the pre-floor fixture, then refuse the framed
history with an older database and zero native/registry calls, through both
file and remote readers. TypeScript kernels at `8bb7312` and `7d43c77` do the
same. The development TypeScript kernel did not exist at `c63e96b`.
CI fetches full history so those tests use actual source rather than copied
approximations. Package tests exercise authenticated legacy schema rejection
and unchanged old installer code with recording host boundaries. Existing
package tests separately exercise actual systemd installation and update.

The installed regression additionally installs a schema-2 fixture with unchanged
`7d43c77` bootstrap/controller modules, demonstrates old-bootstrap schema-3
refusal, and selects the reviewed new bootstrap for the one-way update. The actual
controller then aborts a cancelled fixture order through encrypted remote journal
acknowledgment. A later installed update checkpoints that complete framed prefix,
preserves the retired batch in both copied and live databases, and restarts paused.
The old bootstrap still refuses a schema-2 downgrade afterward. Native/store
ports in this platform regression are recording fixtures, not financial evidence.

The [53-step native receipt](../../regtest/runs/abort-protocol-survivor-qualified-20261113T114658Z-0c3e55.json)
binds 148 source hashes, including both journal codecs and reconciliation
readers. It includes the same paid member's post-abort issue and delivery.
