# Controller recovery operation contracts

## Status and scope

These are proposed implementation requirements, revised after independent review
of the initial specification. They change no shipped Python/TypeScript behavior,
payment rule, package, bootstrap or runtime selection. PR24 remains frozen at
593b6be. Existing conservative refusal rules remain effective until independently
reviewed implementations and their executable lifecycle tests land together.
No new named case, skipped placeholder or coverage exemption is introduced here.

The [wire contract](CONTROLLER-OPERATION-WIRE.md) defines exact requests, results,
canonical bytes, authority references and operation kinds. Native/store API changes
are prerequisites. An Effect wrapper cannot add these guarantees to old endpoints.
The scope is existing preparation, issuance and known-transaction recovery; this
is not a general transaction engine or an arbitrary-history migration contract.

## Authorities and trust

The store owns pending-set replacement, entry/arm grants, terminal arm disposition
and their journal confirmation. The native service owns native staging/commitment
mutations, transaction construction/custody and proof submission. A native result
is never evidence that an independent store request did or did not execute.
The prover owns remote job acceptance/billing; native caching cannot invent that
provider-level guarantee. Each authority has its own durable operation ledger.

A configured, authenticated installation coordinator owns the controller journal
and enumerates every assigned request before dispatch. Its complete acknowledged
history supplies the preparation barrier and cross-service ordering. Correctness
assumes this narrowly authorized coordinator and protected-root custody, not a
malicious credential holder or hostile root. Each service still enforces its own
identity, generation, immutable bindings, deduplication and mutation preconditions.
A public generation number is not a credential. Raw/legacy mutation paths and
background workers must not bypass the same authority rules.

Native admission obtains the exact authenticated live-acknowledged store arm record
outside its local write lock, checks its association with the native request, then
serializes native acceptance, expected-head checks and transaction selection. Store
terminal retirement obtains immutable native no-effect evidence outside its write
lock, then performs its own CAS. No cross-service RPC is made while holding both
services' write locks, and no distributed atomic transaction is claimed. All paths
that retire an unexecuted arm must first fence its bound native operation; other
terminal/supersession transitions require their existing positive send evidence.

## Incarnation, generation and restore continuity

Stable installation/authority identity is distinct from process incarnation. On
every authority startup, restart or supported restore, generate a fresh random
256-bit incarnation before listening, scheduling workers or recovering effects.
Never restore or reuse this value from a ledger, snapshot or installation file.
Within that incarnation, generations are positive monotonic integers for the
installation-wide authenticated owner lease, across all spaces. A new incarnation
may start at generation one; the incarnation/generation tuple must never repeat.

A lease transfer revokes old admission immediately and serializes against accepted
work. It cannot declare drain while a worker or forwarded request may still act.
New conflicting effects stay fenced until that work is accounted for. Current
caller authorization for status/retirement is separate from the original request's
immutable owner, generation and incarnation. Do not rewrite an old request to make
it current. Delayed old-incarnation mutations always refuse.

A no-effect tombstone for an absent ID is permitted only in its still-live origin
incarnation, whose ledger has remained exclusively owned without replacement since
startup. The authority serializes tombstone installation with acceptance and workers.
If acceptance won, it may certify no effect only after proving no effect occurred
and every queued/forwarded effect is permanently prevented. A timeout, HTTP status,
404, empty pending, unchanged tree or stopped local worker alone is insufficient.

Supported restore must stop/exclude the old authority and its workers, create a new
incarnation, and reconcile before mutation. It must not replace a live authority's
ledger in place. Protected-root/single-writer custody and stated durable-storage
assumptions are required; this protocol does not detect hostile root or silent
storage rollback defeating those assumptions. There is no external antirollback
service in version one and no claim that fsync detects an older restored snapshot.

After restart/restore, old-incarnation absence stays unknown. A new tombstone could
prevent future work but cannot prove no past effect. Never use it to release an arm,
retry a job, repeat a local commit or clear an old owner. This deliberately sacrifices
some never-arrived-operation recovery after authority restart. Retained historical
positive results may be queried under current authentication without rewriting their
origin. Exact independent transaction/provider evidence may resolve known outcomes;
missing positive evidence never becomes permission. Unsupported import/adoption paths
remain disabled rather than manufacturing a receipt.

## Persistent operation outcomes

A request ID and exact request digest are acknowledged in the controller journal
before its first same-invocation dispatch. The authority durably records acceptance
before scheduling work, and durably records a result before reporting it. Same ID
and bytes recover the existing record; changed bytes under that ID refuse.
No original request is retried through a legacy or non-deduplicating endpoint.

| State | Meaning and permission |
| --- | --- |
| prepared | Controller intent only; it does not prove service acceptance or absence. |
| accepted | Service owns the request; future/forwarded effects may remain possible. |
| completed | The operation's specified result is known. Store off-host confirmation is a separate gate. |
| partial | Service certifies this request has stopped, with recorded partial effects. It is not no-effect evidence. |
| terminal_no_effect | Permanent tombstone: no effect occurred and this request can never cause one. |
| unknown | Controller knowledge after missing/contradictory evidence; retains ownership and cannot erase a positive result. |

Accepted results may advance by revision. Completed, partial and terminal_no_effect
results are immutable; contradictory terminal results refuse. A partial result needs
fresh exact inventory reconciliation before any continuation; it never authorizes
blind retry or terminal-unused arm retirement. A forwarded unaccounted wallet/prover
call remains accepted/unknown, not stopped-partial or no-effect.

Version one retains identities, original bindings, results and tombstones indefinitely.
No compaction, expiry, generation resurrection or force-clear API is supported. A
later retention policy needs a separate reviewed contract and delayed/restore tests.
Controller SQLite and service projections cannot override acknowledged history.

## Store-owned global pending operations

pending_set and pending_clear go to the store authority, not the native ledger.
Before setting pending, the store records one pendingOwnerId bound to the exact
batch, space, sorted members and digest. It is installation-global because the
existing pending set is global. Another owner cannot replace or clear it. Requests
carry store authority/incarnation/generation and a stable operation ID. The store
serializes owner reservation, mutation, result and retirement with its normal queue.

pending_set requires no owner or that exact active owner, validates current bindings
and batchability, and sets the exact order-ID set. pending_clear compares the exact
owner/current pending digest, clears that set and records owner retirement. A
retired owner ID is a permanent marker: an exact historical retry returns its old
result without touching a successor's set. Any late pending_set for it refuses.
The store must not admit a successor owner until retirement is live-acknowledged.

An off-host acknowledged:false response is not no effect. Its mutation/result can
be locally complete while controller progress and owner transfer stay fenced.
Confirmation is separate from immutable result evidence and may become true on a
fresh exact live-prefix read, without repeating the mutation. A complete false
confirmation is distinct from an unanswered request; neither silently clears the
controller's preparation owner. Missing/old-incarnation store results stay unknown.

The coordinator may clear preparation ownership only after every assigned store
and native request in its live acknowledged owner history is completed/reconciled
or terminally prevented from acting, exact native/store inventory matches, and the
store clear/retirement is live-confirmed. A native tombstone or native worker stop
cannot substitute for store confirmation. Global sync partial effects require all
affected-space inventory, not just the target members. Local-commit ambiguity keeps
its separate one-opportunity fence. Already-sent disjoint-batch progress retains the
[existing availability rules](CONTROLLER-AVAILABILITY.md); no new first-send authority
is granted through an unrelated owner.

## Prospective arm binding and terminal-unused retirement

Before arm dispatch, assign a fresh 64-hex armId and native broadcast operation ID.
Freeze the complete native broadcast request, including entry, expected root/index,
members, delegate, fee rate and native authority incarnation/generation. Compute its
digest before requesting the store arm. The store reservation binds that exact
native request, not just an arm name. There is no circular grant-receipt hash inside
the native request: the store grant binds the already frozen native digest.

The existing entry ID remains 32 hex characters. arm_reserve uses armId as its store
operation ID and atomically records at most one grant for that entry/arm/native
binding. Different native operation/digest/delegate under the same arm refuses.
Native acceptance verifies the authenticated store grant and records one native
operation per arm; it cannot select a different operation using a copied arm name.

A new tagged terminal_unused disposition is distinct from ordinary closed and from
supersession. Retain the original grant record and a grantCount of zero or one;
never delete an arm or decrement its grant count. The terminal record binds the
exact reservation and permanent native terminal_no_effect result. The controller
acknowledges that evidence before invoking arm_retire. The store verifies it and
serializes grant, terminal retirement and retries in one local ownership boundary.

If retirement wins before an original grant arrives, it permanently tombstones the
exact prospective arm/entry binding with grantCount zero and terminalizes its
original arm_reserve operation without a grant; a late original grant or
entry create returns terminal disposition and never acquires locks. If grant wins,
retirement retains that consumed grant with grantCount one. An unknown prior-
incarnation reservation cannot be assigned a fictional grant count or retired from
absence. Changed bindings, possible sends, partial effects, missing live history or
contradictory receipts refuse. There is no arbitrary adoption of legacy armed data.

In the same store commit, release only this entry's still-owned issuing orders to
converted and remove only its own pending membership. Preserve payment addresses,
price reserves, invoices, history, later cancellation/refund state and foreign or
successor ownership. A retry returns the immutable terminal receipt and never
reapplies order changes. An absent entry changes no orders. Foreign global pending
ownership must not be cleared. These are ownership/lifecycle changes, not a refund
or a payment-policy change; fresh eligibility remains necessary for any successor.

A new entry/arm may use the same still-unspent delegate only after every prior arm
for it has a live-confirmed terminal_unused disposition or the existing valid
supersession evidence, with no active/unknown competing owner. Store grant CAS and
fresh native/delegate checks still apply. Each arm grants once; the retained count
across different retired arms may increase. This replaces neither an old grant nor
the native operation ID. No fake supersession or attempted-flag reset is allowed.

A retired store entry does not remove an unbroadcast native root. Before preparing
a changed successor, use the narrow rollback_local contract, with exact typed root
ownership and no-send evidence; all preparation/restore fences remain. An old
retirement retry cannot roll back a successor head. Known transaction recovery
uses attach_txid/rebroadcast_known and positive transaction or irrevocable exact-
transaction dispatch-claim evidence, never an unused-arm path. Prepared signed
bytes alone are not evidence that a send occurred or authority to recover it.

## Expected-commitment send and prover ownership

Under the native mutation boundary, compare immutable commitment identity, root,
index, member digest, intended delegate, proof state and request authority before
selecting/building the transaction. A fee-rate-only POST or extra GET is insufficient.
Persist exact prepared transaction/ancestor bytes before a wallet send and a durable
dispatch claim before forwarding. After that claim, a crash cannot justify a new
transaction or a no-effect certificate from plausible absence. A duplicate completed
first-send request returns its result; it does not create a new broadcast permission.
A retained irrevocable dispatch claim binds the exact signed transaction even if
its physical send is unknown. Its recovery preserves that logical authority; mere
prepared bytes without a claim are insufficient. Known-byte recovery keeps its
explicit path and existing live guards.

Persist one proof identity for exact input/provider/pricing binding and a durable
non-retry dispatch claim before remote submission. Provider deduplication/status
must cover its own restart and billing authority. Native caching alone is insufficient.
With that capability, only the same provider proof identity/input may be resubmitted.
Without it, a claim followed by ambiguity permanently pauses automatic submission,
even if the process died before the actual call. No 404 or lost job ID grants a
replacement. Version one grants no additional-job or additional-charge policy.
Recover_known may only poll/verify an existing positively bound job and apply its
verified proof to the exact native head; it cannot submit a job. Unsupported proof
import/adoption remains disabled. Verify actual proof inputs, not a success flag.

## Compatibility, maintenance and test requirements

Before new effects, acknowledge the controller SSCJ4 floor and the separate store
SSSJ2 floor defined in the wire contract. Old stores do not read the controller
floor. Package/native/store capabilities, all journal/reconciliation/checkpoint
readers and the separately trusted bootstrap must support both before selection.
An old authenticated entry/pending request cannot bypass the activated store floor
through its older strict HTTP shape. Unsupported capabilities refuse before effects.

Activation and full restore are maintenance protocols, not unrecorded controller
operation kinds. Establish real exclusive lifetime ownership, pause value effects,
stop/exclude old processes/workers, create fresh incarnations and qualify both
floors/readers before admission. Do not restore a live ledger or silently erase old
unknown claims. Existing history bytes stay unchanged. Legacy unresolved arms or
one-use intents lacking these bindings remain held; this is not a general cutover.

[ENTRY-RELEASE](ENTRY-RELEASE.md) and [ENTRY-RECOVERY](ENTRY-RECOVERY.md) keep their
implemented rules and named tests. terminal_unused is only a proposed capability-
gated exception. Its models, effective specification changes and actual integration/
native tests must land with implementation; existing expectations are not waived.

Required negatives include after-final-read head/delegate/index changes; raw and
background writers; store pending A delayed beyond B; grant versus retirement before/
after forwarding; false confirmation; response loss; dispatch-claim crashes; same
ID with changed input; same-delegate successors; later cancellation/foreign owner
followed by an old retirement retry; lost native/store ledgers; snapshot rollback
that loses acceptance or tombstones; old-incarnation requests; unsupported/missing
floors; provider acceptance without reply; and partial global sync. Assert exact
grants, wallet transactions, releases, jobs and charge identities. Pure models and
recording ports do not establish native serialization, process ownership or billing.

## Bounded port order

First port strict read-only native facts and the official verifier boundary under
TypeScript/Effect, with no runtime selection, effects or Python deletion. Pin official
`@spacesprotocol/libveritas` to native 0.4.4 for this source. Exercise every API used,
production verification options, exact certificate bytes and malformed/trailing,
recipient and anchor negatives. The two-fixture/ten-check spike is preliminary.

Native/store capability implementation precedes its effectful controller callers.
Proving, checkpoint/process ownership, send/recovery, observations/certificates,
publication and supersession follow in bounded PRs with their corresponding native
scenarios. For unchanged behavior require Python/native and TypeScript/native
agreement. Keep unsafe frozen results as explicit negative controls with specified
successor differences, separated from pure translation changes. Remove replaced
Python only after equivalent native scenarios and negatives pass, retaining history.
Runner/recovery, deployment and tooling follow. Bootstrap remains a separate PR;
a Python-free bootstrap requires a separately trusted pinned Node runtime first.
