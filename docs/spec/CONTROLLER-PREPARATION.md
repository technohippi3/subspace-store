# Bounded controller preparation

The TypeScript/Effect controller now freezes, stages and makes one local
commitment for a batch. It stops at `committed_local`; proving, checkpointing,
native setup, runner selection and installed native qualification remain
subsequent work. `CONTROLLER-PORT.md` defines the complete delivered scope.
The active Python controller retains selection, with the runtime safety
amendments below. These are lifecycle repairs, not new payment rules or a
change to the independent payment model.

## Frozen identity and admission

Freeze observes current converted orders and live batchability, excludes IDs
already in an open batch, and permits only one open batch per space. B5 gates
freeze, stage and local commit. Membership is sorted, unique and immutable.
The digest remains SHA-256 of Python's default spaced, ASCII JSON encoding
of sorted `(full handle, recipient script, order ID)` tuples. A new batch
and its prior chain root are saved and acknowledged before pending or native
mutations. The database lock and command semaphore serialize the TypeScript
library; neither is a distributed native service lock.

The internal TypeScript API accepts at most 1,000 requested order IDs. An
explicit invalid, unavailable, duplicate or partly ineligible request refuses
as a whole. This conservative admission is stricter than Python's existing
selection, which filters an explicit set against eligible candidates. Python
selection has not been silently changed. Every subsequent preparation step
reconstructs the frozen tuples from fresh bindings, requires distinct full
handles, converted status and current batchability, and compares the digest.

## Concrete native facts

The preparation ports expose the pinned public pipeline, handle, page, sync,
parking and commit response shapes. A chain RPC failure is not an absent
root; only a successful explicit null means no chain commitment. Required
nullable fields must be present. Numeric counts, booleans, names, scripts,
statuses, roots and commitment indices are validated before use. Handle
facts containing private-key fields refuse.

Before preparation mutation the fresh chain root must equal the batch's
prior root, and the native pipeline must have that root, no pending pipeline
and, for a nonnull prior root, a transaction ID. This bounded implementation
requires an already loaded, inspectable native space and either an initial
empty head or a finalized prior pipeline. At pinned subs `4dcc923`,
`has_pending = !is_done && current_step != "published"`, so a finalized
commitment awaiting publication reports false and preparation is permitted.
Publication is downstream distribution, not a preparation precondition.
Native setup or transport errors never
manufacture an empty initial head.

Readback exhausts stable pages of 100 rows, with a bound of 10,000 staged
or committed handles. Missing rows, duplicate names, changed counts or
inconsistent pagination refuse. The committed count plus new membership
must fit this bound before the commit intent is recorded. Expected members
must be absent or have their exact script and null root before staging.
Committed handles are never parked or unparked by preparation.

Staging acknowledges the exact pending set before requesting sync. Aggregate
sync counts are not proof of the target space's staging: pinned sync visits
multiple spaces and can report their errors. The controller parks unparked
staged strays, unparks only expected staged members, then rereads the complete
unparked staged set and each member's exact script and null root. It clears
pending only afterward, and requires an exact live acknowledgment before
recording `staged`. Preexisting exact staged members need no sync.

## Global ownership and unanswered requests

Runtime amendment, 2026-11-13: both implementations journal a version 1
`preparation_pending` owner before pending/native staging mutations. Its
binding is the batch ID, space, sorted members and digest; its phases are
`owned` and `cleared`. Each pending set, sync, park, unpark and pending clear
has a `preparation_effect` intent and confirmed record with that binding,
operation and exact sorted labels. A completed pending receipt additionally
records its explicit acknowledgment boolean. Known records and transitions
are validated; overlapping owners/effects, unsupported versions and clearing
without confirmed acknowledged pending clear refuse.

The intent is acknowledged and freshly read back immediately before its
one same-invocation request. A missing or malformed response, crash after
intent, or completion absent from acknowledged live history retains the
global owner and unresolved operation. A confirmed record that survived
reply loss can establish completion on later live journal readback.
Delayed original requests can arrive after a retry or
plausible readback; the pinned APIs have no operation IDs or whole-request
lock. Therefore no retry, native readback, empty pending result or parent
retirement clears this ambiguity. A separately established reconciliation
procedure is deferred. This slice intentionally provides no force-clear API.

An exact completed `{acknowledged:false}` pending reply differs from no
reply: it records completion, retains ownership and withholds sync or staged
completion. The same owner may later make a new acknowledged request. The
bound Python `TypeScriptStore` now returns this explicit boolean; the legacy
Python store protocol remains unchanged.

A retained owner prevents another batch from replacing global pending. An
unresolved operation prevents further staging, commit, unsent release, issue
or send, including after process restart. The active Python controller also
fences direct proving, checkpoint, readback, recovery, snapshot, supersession
and publication mutation entrypoints. Read-only diagnostics can still report
the retained owner. A completed stage clears ownership only after acknowledged
pending clear; a crash before the final `staged` row can finish by exact
readback without repeating pending/native effects.
Conservative startup recording of local uncertainty or adoption of existing
acknowledged safety evidence remains possible. It neither permits external
work nor clears preparation ownership.

These events retain the Python JSONL envelope and remote stream protocol.
That format compatibility does not qualify alternating old and new controller
writers mid-stage: an older implementation ignores the new ownership rules.
Existing histories are retained. There is no general live-controller cutover
or arbitrary-history migration claim.

## One local commitment opportunity

Runtime amendment, 2026-11-13: the existing Python-shaped
`commit_local_intent` consumes one batch's sole local commit opportunity.
Before the first request, the controller rechecks the native head, exact
unparked staged set, every null member root, immutable bindings and readback
capacity. It acknowledges the intent and confirms its exact live history
before the one call. Any preexisting intent with a staged/rootless batch
requires reconciliation, even if native readback appears unchanged. Lost
before-forwarding replies are also ambiguous; they never justify retry.

The commit response must bind the exact space, previous root, new root,
member count and initial/noninitial flag. Fresh readback verifies every
member's script/root, absence from staged rows, the complete new-root
committed membership, and a local pending pipeline with no transaction ID.
Only then is `committed_local` saved and acknowledged. A known committed
row can be checked read-only; it cannot call commit again. If the final row
and old rootless journal disagree, conservative refusal is allowed and is
not reported as successful resume. There is no automatic root adoption,
rollback, recommit or invented proof recovery.

Local commit ambiguity is per batch and space. Global ownership fences the
pending/sync/parking requests that can affect other spaces. One open batch
per space prevents a successor local commit there. These distinct barriers
do not claim control over an unrelated external native writer.

Restoring both controller copies before intent cannot justify preparation
against an advanced native head or committed members. The rootless first
retirement path now makes the same native head and absent-or-exact-script,
null-root checks before creating a successor. It also refuses any retained
local or same-batch journal send evidence. Without preparation readback ports,
TypeScript refuses that first retirement. An already retired parent's
completion retry remains read-only and permits its child to progress.

## Evidence boundary

Runtime amendment following external audit, 2026-11-13: the selected Python
controller now checks the exact native pipeline head, absence of a native
transaction ID, and every member's label, recipient script, root, commitment
index and unparked state during proving, before and after the coordinated
checkpoint, and before consuming its first-send arm. It rereads the head after
member reads. The post-arm check runs again immediately before `/broadcast`;
a failure there retains attempted uncertainty and never grants another arm.
An absent or changed head before arming refuses without consuming the attempt.
The checkpoint cannot become `checkpointed` if restart loses the commitment.

The existing restore helper `subs_holds()` only checks member roots and is
insufficient here: `/broadcast` selects the latest native commitment, which
may differ while older member roots remain unchanged. These checks require
the installation's exclusive native writer; separate HTTP readback is not an
atomic fence against an unsupported external writer. Durable proof-submission
ownership and preparation-fence reconciliation remain unfinished. A successful
source regression does not qualify native restart or a release package.

The `controller-preparation-*.test.ts` tests use real authenticated store
HTTP, SQLite, JSONL, native HTTP recording facts and child processes with
durable effect counters. They distinguish intentional exit 9 from ordinary
refusal at ownership, effect intent/completion, pending clear, stage and
commit boundaries. Tests cover before/after-forward reply loss, delayed
pending/sync/unpark effects, false acknowledgments, stale copies with native
ahead, strict malformed facts, stable pagination, capacity, immutable bindings,
complete committed membership and direct send fences. The existing controller
case fixture now supplies the same pinned public shapes and reads the actual
pending listener. Python focused tests exercise the active repairs and direct
mutation fences; actual HTTP Python preparation/crash composition runs from
the TypeScript suite.

The native service is a recording stand-in with made-up roots. These checks
establish source protocol and normal-process crash behavior, not real Merkle
commitments, proving, snapshot safety, Spaces sends, package acceptance,
whole-host recovery or production activation.
