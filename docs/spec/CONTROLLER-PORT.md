# TypeScript controller preparation, entry and release kernel

The development controller under `ts/src/controller/` composes Effect with
the existing controller batch states. It now freezes, stages and verifies
one local commitment as specified in `CONTROLLER-PREPARATION.md`. Its issuance
input remains a preexisting checkpointed batch with a bound root and exact
sorted member IDs. It ports
the entry and first-attempt rules in `ENTRY-RECOVERY.md`, bound known-unsent
release/rebuild in `ENTRY-RELEASE.md`, B5's durable throttle and
interrupted-answer rules A20–A22. Safe precommit retirement requires concrete
native preparation readback. Proving is not implemented. It adds no payment rule or independent
model change.

The shipped Python controller and attended runner remain selected. This
library has no command entrypoint, polling loop, native service setup or
deployment selection. It cannot prove or checkpoint a batch.
It supplies neither commitment readback/rebroadcast nor
finality, certificate, publication, supersession, snapshot or whole-host
reconciliation. Those ports and their real-native/package acceptance are
required before the controller can replace Python. Full Python removal
remains the target in `PORT-PLAN.md`.

The [preparation availability amendment](CONTROLLER-AVAILABILITY.md) defines
completed-owner abort and sent-batch progress through unrelated ownership.
Unknown request outcomes, post-arm recovery and prover ownership remain open.

The [mandatory protocol amendment](CONTROLLER-PROTOCOL.md) excludes older
JSON-only controller builds after abort activation and defines native proof
that a surviving paid member can complete a fresh batch after abort.

The proposed [recovery operation contracts](CONTROLLER-RECOVERY-CONTRACT.md)
govern the remaining effectful port. The current library does not implement the
new native operation ledger, terminal arm closure or prover deduplication.

## Ownership, storage and history

Opening acquires the existing lifetime database flock before schema work,
the journal factory or startup settlement. Scope closure releases it;
failed startup also closes the database and releases ownership. Concurrent
commands on one instance serialize through an Effect semaphore.

Only the controller's three-table batch/alert/recovery schema is admitted,
including its existing nullable additive migrations. Unknown tables,
views, triggers, extra indexes and changed column/constraint definitions
refuse before schema mutation. A missing journaled batch or unfinished
recovery refuses with restore required. Admission is deliberately bounded;
it does not qualify arbitrary historical databases for cutover. Batch
membership and field shapes are checked. Preparation reconstructs and checks
the immutable tuple digest; issuance of supplied checkpointed batches still
trusts their digest. This kernel does not prove the frozen tree.

The controller retains the existing Python JSONL envelope:
`{"seq":1,"kind":"batch","batch":{...}}`. Other sequenced controller
events are preserved as opaque history, except for the explicitly validated
versioned rebuild-guard and preparation ownership/effect records. The store's DurableStore envelope
is separate. Complete prefixes require contiguous sequence numbers, valid
UTF-8, unambiguous JSON and validated batch rows. Previously read bytes
cannot change or disappear within an instance.

The local backend requires an existing dedicated directory. Append, file
fsync, directory fsync and exact readback precede acknowledgment. The
existing `<name>.down` marker refuses access. This preserves Python JSONL
read/write compatibility; it does not give that legacy plaintext format a
cryptographic origin proof across independent starts.

Versioned global ownership and per-request staging effects preserve unknown
pending set/clear, sync and park/unpark outcomes across restart. No plausible
readback releases an unresolved request; the library refuses onward external
work for separately established reconciliation. Conservative local startup
safety evidence may still advance. A completed false
pending acknowledgment withholds progress while permitting its exact owner
to make a new request. One local commit intent is separately consumed per
batch/space. No automatic retry, root adoption or proof recovery is provided.
Older controller writers that ignore the ownership events must not alternate
mid-stage; compatible JSONL envelopes are not cutover qualification.

Preparation requires a loaded inspectable native space and an initial or
finalized prior pipeline. Pinned subs reports `has_pending=false` while a
finalized commitment awaits publication; publication does not block the next
preparation. Full stable staged and committed pages are bounded
to 10,000 rows, and capacity is checked before commit. The strict explicit
TypeScript selection API refuses a partly ineligible request; Python retains
its existing filtered selection.

The remote adapter retains the recovery client's `controller` stream and
`journal-read`/`journal-append` request and acknowledgment shapes. It checks
every returned object digest and sequence over the full bounded prefix,
uses stable exact pending bytes after a lost append response, and confirms
readback before acknowledging a new event. Pending bytes are resolved before
exposing history for another count, reset or progress decision, including
when the lost request never reached storage. A transport outage never selects
a local mirror. Tests exercise the transport callback and Python-produced
history; they do not qualify an installed remote-backend cutover.

## Entry and one first-send opportunity

Before any entry lookup or creation, the controller durably saves and
acknowledges one stable random entry ID with the root and exact members.
The strict HTTP adapter rejects unknown or duplicate fields, changed IDs,
roots or member order, invalid phases/delegates and ambiguous booleans.
Requests have a finite timeout, a bounded response body, injected operator
credentials, no redirect following and no request retry or protocol fallback.

An absent entry is created with the same ID only after fresh member checks.
A recovered open entry must remain acknowledged and batchable. A closed
entry uses fresh converted-order checks; an open issuing entry uses the
issuing recheck. A failed binding enters the known-unsent release protocol.
An already armed entry becomes uncertain and cannot grant a first send.

Before requesting an arm, the controller verifies its exact live journaled
issuing intent and the store's exact live bound-entry receipt. The store
lookup itself obtains fresh payment observations and recomputes current
member eligibility and journal confirmation. The public internal `send`
boundary applies the same checks. A cached issuing record cannot bypass
payment-depth loss or a journal outage.

The durable local attempted flag is written before requesting the exclusive
one-use arm. After a successful exact arm grant, both live journals are
checked again before the sole broadcast call. An arm failure, missing reply,
repeated grant or lost post-arm confirmation writes uncertain state and its
alert together, with no broadcast. No reply or unusable response after the
call likewise becomes uncertain. Responses retain up to 2,000 characters
and the original character count when truncated. Every second send refuses.

A successful response records its transaction ID before asking the capture
port for signed bytes. Capture failure preserves that known broadcast and
does not permit another call. Native adapters are trusted here to bind raw
transaction and ancestor bytes cryptographically to their transaction IDs.
The kernel checks shape and matching claimed identity only; the fixture's
made-up bytes are no evidence of native transaction verification.

## Known-unsent release and rebuild

Release and release-resume compare local and complete journal history before
writing progress. Attempted, sent or contradictory transaction evidence
refuses. Legacy batch rows are normalized before that check, so absent
nullable migration columns are not mistaken for send evidence. A conflicting
batch binding refuses; stale progress cannot erase a newer send or intent.

The controller persists and acknowledges `releasing` before exact store
closure, then persists and acknowledges `rebuilding` before native work.
Live exact closed-entry confirmation and controller-journal checks immediately
precede rollback and parking. An armed observation records the exact delegate,
intent, attempted uncertainty and its alert atomically, including when the
local row claimed rebuilding. No native action follows an unavailable journal.

Fresh member inspections must carry known statuses outside issuing, ready
and fulfilled before first retirement, rollback and parking. This also covers
failed members and the rootless precommit path. Closing a new absent entry
ID does not prove that another entry no longer owns those orders. An already
retired parent's completion retry only validates its existing successor;
that child's later legitimate issuance remains allowed.

Native readback checks every exact recipient script and root. Rollback is
permitted only for the original complete root; all-null roots skip a rollback
that already happened. Mixed or foreign roots refuse. A rollback intent is
acknowledged first. Lost close, rollback or parking replies resume through
exact readback and idempotent operations. A rootless precommit batch can
retire only without entry, intent or any unresolved `commit_local_intent`,
and after fresh native head/prior-root and absent-or-exact null-member checks.
Missing preparation ports or advanced native state refuse before retirement.

After fresh observation the failed set can only grow. Persisted exclusions
from database and journal are unioned on restart, and rebuilding never
downgrades to an older releasing row. Failed handles are parked and every
member's script, null root and parked flag are checked. Parent retirement
and its sole frozen successor, or its all-failed alert, commit in one SQLite
transaction. The successor digest uses Python's existing sorted tuple and
spaced JSON encoding. Completion acknowledges child and parent; a newer or
conflicting child journal cannot be overwritten by an old parent retry.
A journaled child absent from the database still requires restore.

B5 counts distinct failed parents in acknowledged `rebuild_guard` history.
Retries, process death, intervening failures and resets cannot count an old
parent again. The third failed parent retires without a successor and alerts;
new issue and the internal send boundary wait for a later observed block.
A fresh successful issue binding and delegate read reset the global count
before intent/send. Resuming an existing intent preserves intervening counts
and cannot clear a pause. Historical paused parents remain childless after
later blocks and resets. Explicit operator rollback does not add a failure.

The 2026-11-13 runtime repairs in `CONTROLLER-DESIGN.md` and `ENTRY-RELEASE.md`
also update the active Python controller: all-history failure-ID deduplication
and fresh all-member status checks before first retirement/native mutations.
Existing history is retained without retroactively rewriting old counts.
`CONTROLLER-PREPARATION.md` records the subsequent active Python extraction
and safety repairs: global staging ambiguity barriers, strict bound pending
receipts, one local commit opportunity and rootless native-ahead/send-evidence
refusal. Python remains selected; preparation is split into cohesive modules
instead of expanding the controller core.

## Restart and evidence

An intact local issuing row with attempted false can resume after fresh
checks, even when its intent was acknowledged before the interruption.
Attempted true becomes uncertain before callers receive the controller.
Uncertainty and its alert commit atomically; an unavailable journal leaves
the local result durable for later acknowledgment without a second alert.

An older checkpointed database may adopt a newer matching journaled entry
identity. Adopting a newer issuing intent means the local attempted evidence
was lost, so the result is uncertain even if that journal row has attempted
false. A later acknowledged sent state is adopted with its bytes and one
database-behind-journal alert. Conflicting immutable identity or intent
refuses startup. Startup never contacts native or registry ports or sends.

The `controller-port-*.test.ts` and `controller-rebuild-*.test.ts` production tests use real SQLite and the
existing TypeScript store's authenticated HTTP listener. They cover A20–A22,
A24–A26, O16, O19 and the arm-loss portion of O23. Entry reply loss before
and after forwarding exercises the O15 boundary. Release adds O23–O26,
A27–A31 and B5 composition checks. Child Node processes exit
after entry identity, store entry, intent, local attempt, arm, send, release
and closed progress, rollback intent/effect, parking, atomic retirement,
child/parent acknowledgment, guard acknowledgment and fresh-binding reset,
then restart over retained files. Separate tests read Python-produced
SQLite/JSONL and read TypeScript appends using the Python Journal, reject
malformed histories/schema, and force a SQLite alert failure to prove the
uncertainty and retirement transactions roll back as units. A separate Node
recording recovery command exercises remote mixed-event loss before and
after persistence. The Python HTTP controller fixture also reproduces the
forgotten-entry refusal against the actual TypeScript listener. These are
process/protocol tests, not SSH or native-wallet qualification.

Broadcasts and native capture are recording stand-ins. These checks establish
source-level controller/store composition and normal-process restart only.
Preparation adds real store/native-recording HTTP and child-process tests
described in `CONTROLLER-PREPARATION.md`; their generated roots are not
native cryptographic evidence.
They do not establish real Spaces sends, native-byte validity, installed
package acceptance, whole-host recovery or a production controller switch.
