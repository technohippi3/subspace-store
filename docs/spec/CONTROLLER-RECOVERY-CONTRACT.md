# Controller recovery operation contracts

## Status and scope

These are proposed implementation requirements for the controller successor.
They do not change the shipped runtime or establish acceptance. They follow the
independent 88-path review at
593b6bece79b2550658fc3b9962cfbfb0c47b9d0. PR24 remains frozen. No Python rule,
TypeScript behavior, database, journal format, bootstrap or package changes here.
The draft proposes lifecycle contracts, not payment policy. It introduces no
named case IDs, skipped tests or coverage exemptions. The implementation PRs
must supply their executable regressions with the corresponding effective rules.

The following contracts must govern effectful controller porting. Native API changes are a prerequisite for the promised
native guarantees; an Effect wrapper cannot add them to the pinned endpoint.
The existing conservative refusal paths remain the implemented baseline until
reviewed successors demonstrate the new behavior.

## Persistent operation identity and custody

Every native preparation, send or proving effect covered here has a stable
operation ID generated and durably acknowledged before
its first request. It binds installation/network identity, space, batch, immutable
member digest and exact request digest. Send operations additionally bind entry,
arm identity, commitment root/index, delegate, fee policy and native generation.
Proving additionally binds exact input digest, proof kind/index and prover identity.
Reusing an ID with different bytes refuses. Resending identical bytes is allowed
only to an endpoint that durably deduplicates this identity; it is not a new effect.
An acknowledged intent and its operation ID survive database restore through the
live immutable journal. A database snapshot cannot erase later acknowledged work.

Native mutation ownership must be enforced at every mutating native route, not
only in the controller database flock or the wrapped native process. A durable,
monotonic fencing generation must be checked when effects are accepted AND when
work can still mutate state. Background workers, raw mutation routes and commit,
rollback, pending, sync, park, broadcast and restore paths must share that rule.
A caller without the matching generation refuses. A process restart must not
reset generation or forget accepted operation IDs. Unsupported native versions
must refuse the new workflow before any effect; no retry through an old endpoint.

Advancing a fence is not proof of quiescence by itself. The native implementation
must serialize acceptance against fencing and account for accepted workers and
queued/forwarded requests. A completion may be published only when old-generation
work can no longer produce a later effect. A host PID disappearing, a timeout,
a 404, empty pending or unchanged head does not prove this condition.

## Durable result states

The logical states are prepared, accepted, completed, terminal_no_effect and
unknown. Prepared is a controller intent, not native acceptance. Accepted means
the native authority has durably recorded the operation and owns its effects.
Completed includes the exact result and effect evidence. Terminal_no_effect is
an authoritative permanent tombstone: this ID and all copies/late arrivals can
never produce an effect. Unknown covers lost or contradictory evidence and keeps
ownership. A result query returns the binding, generation and stable evidence;
it cannot infer terminal_no_effect merely from absence in a volatile map.

Partial effects require an explicit result and reconciliation, even if the final
HTTP request failed. Contradictory histories, rollback of an operation ledger or
an authority unable to establish its generation must pause the affected work.
Keep a durable tombstone or an equivalent non-reusable generation boundary for
as long as delayed delivery or restoration of an old controller can occur.
Retention and compaction must never make a retired ID executable again.

## Expected-commitment first send

The controller acknowledges its immutable send binding and validates the store's
exact one-use arm before dispatch. Native acceptance checks the expected local
commitment identity, root/index, delegate and generation under the same serialized
ownership that selects and builds the transaction. The legacy fee-rate-only POST
cannot satisfy this contract. Extra GET requests are diagnostics, not a send fence.

Before any wallet send, native storage must durably own the operation and retain
sufficient exact prepared transaction/ancestor bytes and transaction IDs to resume
without selecting or signing another commitment. A lost wallet response or crash
before txid persistence cannot authorize a different transaction. Where the wallet
cannot prove an outcome, the same operation remains unknown and fenced. A repeated
accepted request recovers its original result or identical transaction bytes.

The response binds the selected commitment and operation to verified transaction
evidence. The controller independently checks that evidence before advancing its
batch. Failure to confirm the response preserves uncertainty; it does not grant
another arm. Known transactions may be observed or rebroadcast using the same
journaled bytes and ancestors. No new signing or first-send permission is implied.

## Post-arm recovery

A reserved arm with authoritative terminal_no_effect evidence differs from a
possible send and from a known transaction. Until that evidence is acknowledged,
a post-arm refusal retains current uncertainty and ownership. In particular,
the existing zero-dispatch test does not authorize resetting attempted in a live
installation: the durable authority must also exclude every delayed original call.

To retire a definitely unused permission, first make its native operation
permanently non-executable, then reconcile exact store/native bindings, then
acknowledge the terminal evidence and close that store arm permanently. A lost
close response is recovered against the same arm. A successor receives a new
operation/entry only after closure is proven. This is not reuse of the original
one-use arm. A crash between those steps must allow only completion of retirement.

Possible-send operations retain their original entry and operation ID until
native status supplies authoritative terminal or transaction evidence. Manual
recovery follows the same evidence rules; journal editing or operator assertion
alone supplies no clearance. Known transactions retain exact-byte rebroadcast
and all existing recipient, finality, store and supersession checks.

## Unknown preparation requests

Pending set/clear, sync, park/unpark and local commit use operation identities,
exact payloads and fenced native results. A completed false acknowledgment is
known completion and is distinct from no reply. Reconciliation must inventory
partial mutations and compare every frozen member, script, root and staged set.

Ownership clears only after every prior operation is durably completed with its
reconciled effect or terminally prevented from executing. A fence/drain protocol
must cover forwarded requests and background work. If it cannot establish that
condition, leave the owner unresolved. Completed-owner abort stays a separate
path and never becomes an escape hatch for an unknown request. Sent-batch progress
through an unrelated owner retains its existing disjointness and evidence checks.

## Durable prover submission

Persist a stable proof identity and immutable input/pricing binding before remote
submission. Native transport and the prover must deduplicate that identity and
allow status recovery after response loss. Store the accepted provider job ID and
receipt before allowing another submission. Polling must not create a new job.

If the provider offers no idempotency/status contract, an ambiguous accepted
submission remains unresolved: do not automatically create a second job. A 404,
missing local job ID, process death or a changed polling flag is insufficient
negative evidence. Completion must verify the actual proof against the bound
inputs, not merely a provider success flag. An intentional replacement requires
separate explicit policy, terminal ownership/charge disposition and a new identity;
this draft grants no replacement or additional-charge authority.

## History, compatibility and restore

The eventual protocol must encode operation records as mandatory versioned history
that older effectful writers refuse before external work. The mandatory wire boundary is specified below. Its database migration must land
with the corresponding implementation and tests against unchanged historical readers. Do not silently add ignorable JSON fields
and call that a compatibility boundary. Unsupported requirements refuse with no
side effects; there is no plaintext/local mirror fallback during a journal outage.

Restore must replay later acknowledged intents/results and reconcile the native
operation ledger before permitting mutation. Older databases, restored native
state and remote ledger divergence require an explicit fail-closed procedure.
No reset to an empty operation ledger or fresh installation may forget obligations.

## Required evidence before effectful selection

Exercise head substitution immediately after the final read; stale delegate,
generation and commitment index; simultaneous raw native mutation; delayed
original requests; partial sync; reply loss before and after acceptance; duplicate
same-ID requests; same ID with different bytes; crash around transaction construction,
wallet acceptance, result persistence and arm closure; job acceptance without a
reply; prover status loss; restart and older database/native restore. Assert exact
arms, builds, wallet sends, releases, accepted jobs and charge identities.

Recording-port and model tests establish deterministic behavior but cannot establish
native serialization, transaction custody or provider billing semantics. The
corresponding native scenarios must run against the exact selected binaries and
source. Installed abort and the final same-package native/browser/buyer/operator
checks remain separate acceptance work. No scenario is verified by this document.

## Bootstrap and installer boundary

The accepted generated profile uses independently verified installation plus
protected-root custody. It does not claim per-invocation verification of every
direct payload prelude. Keep that trust model explicit while porting.

Bootstrap compatibility is a separate PR: require an incompatible signed envelope
and reviewed bootstrap capabilities before staging/maintenance. Verify unchanged
schema-3 as well as schema-2 bootstraps refuse the actual successor before effects.
Manual and Alchemy select the same independently provisioned sibling inventory.
A Python-free bootstrap requires independently trusted pinned Node before it
verifies or executes a release. This draft chooses neither a runtime provisioning
method nor a permanent Python exception and implements no new bootstrap format.

## Version-one authority and retention decisions

The native service owns a durable operation ledger, separate from controller SQLite.
Its header binds an installation identity, network, native-instance identity and
monotonic generation. Operation IDs are random 256-bit lowercase hexadecimal values;
identifiers are never reused, including after retirement or restore.

The immutable request preimage has exactly `version: 1`, `operationId`,
`operationKind`, `bindings`, `nativeInstance` and `generation`. `bindings` contains
the domain inputs listed above, not another envelope or a digest of itself.
`requestDigest` is SHA-256 of that object encoded as canonical UTF-8 JSON with
sorted keys and no insignificant whitespace. Transport authentication and the
requestDigest/result fields are excluded from that preimage; every effect-bearing
domain input must be included. The native service recomputes the digest.

Integer protocol values are nonnegative integers within
the cross-language safe integer range; JSON floating-point literals and duplicate
keys refuse. Fractional fee rates use exact canonical decimal strings, without
exponents or redundant leading/trailing zeros, such as `"1.25"`. Encoding must
preserve the configured rate and existing fee caps; rounding to a different rate
is not permitted. Monetary values use existing exact integer units. Native roots, recipient bytes and proof
inputs retain their existing canonical encodings.

Each operation stores version, ID, kind, request digest, immutable bindings,
generation, state, result revision and evidence digest. The immutable bindings
include the installed native/prover capability contract. Repeated identical input
returns the existing record; changed input under the same ID refuses without an
effect. Unknown fields or capabilities refuse at an effect-bearing boundary.

The ledger fsyncs acceptance before scheduling work and fsyncs result evidence
before reporting completion. All relevant native mutation routes, workers and
restore tools enforce the same authenticated owner/generation boundary. A route
that remains reachable without that boundary makes this capability unsupported.
Generation ownership changes serialize with acceptance and all outstanding work;
revocation closes future admission immediately, but cannot claim drain while an
accepted worker can still act. There is no force-clear operation.

Version one retains operation identities, request bindings, results and terminal
tombstones indefinitely. No ledger compaction, tombstone expiration or generation
reset is supported. A future retention policy needs a separate contract and tests
against delayed requests and restored old writers before it is enabled.

The controller journal holds acknowledged request bindings and recovered result
references. The native ledger is authoritative for native acceptance/effects; the
store is authoritative for its arm; neither controller SQLite nor a local receipt
can override them. Restore reconciles these three authorities. Missing, rolled-back
or contradictory native evidence leaves the operation unknown. A replacement host
or new native-instance identity cannot declare an old operation unused. A service
rejects operation bindings naming another native instance; it cannot adopt IDs
from a lost instance to certify that they had no effect. Loss of the
ledger without independently verifiable terminal/transaction evidence therefore
preserves the hold, including across host replacement. This deliberately accepts
availability loss rather than inventing a recovery certificate.

A terminal-no-effect operation may be created for a prepared ID that has not
arrived at the native service. The retirement call carries that exact ID and
request binding. Under the same acceptance lock, the service either returns the
existing result, waits for/proves cessation of accepted work, or durably installs
a terminal tombstone before admitting any later copy. It must never translate a
not-found query into no-effect evidence without that permanent rejection step.
Acceptance alone cannot establish no effect. Partially effective work cannot
be declared unused by retirement; cancellation of accepted work needs durable
evidence that it produced no effect and can produce none later.

## Terminal arm closure decision

A version-one closure request binds the exact store entry and arm, operation ID,
request digest, native instance/generation and permanent terminal_no_effect result
revision/digest. The controller retrieves that result from the authenticated native
authority, verifies the immutable bindings, and acknowledges it in the controller
journal before asking the authenticated store to close the arm. A caller-supplied
free-text assertion is insufficient. This uses trusted authenticated service
boundaries; it does not claim a new public cryptographic proof of non-broadcast.

The store closure is one atomic compare-and-set on the exact armed entry: bindings
must match, no transaction/send evidence may exist, and no other closure result
may replace it. It durably journals and acknowledges terminal closure before
returning a versioned receipt containing entry, arm, operation ID, evidence digest
and closed phase. Repeating the identical request returns that same receipt.
Different evidence or a changed entry refuses. An unanswered close grants no new
entry; recover its acknowledged receipt first. Existing one-use grant counters
never decrease. The original arm remains permanently consumed and closed.

An accepted or unknown native operation, partial-effect result, unacknowledged
controller evidence, journal outage, ledger loss or contradictory store receipt
cannot use this closure path. Fresh eligibility/delegate/native checks are still
required for any later successor batch. This contract must be implemented in the
store and native service before a controller exposes terminal arm retirement.

## Prover capability decision

Version one supports one proof submission identity per exact proof input/provider
binding. Bind a provider capability/version and the applicable pricing agreement
identity when the job can incur a charge. The provider or its authoritative
submission service must durably deduplicate and query that identity, including
across its own restart. A native-only cache is insufficient when the provider can
accept a job before the native cache records the answer.

A provider lacking that capability can support one explicitly bounded submission,
but ambiguous acceptance permanently pauses automated submission for that proof.
No timeout, local missing job, provider 404 or process restart grants a replacement.
Version one has no replacement-job or additional-charge policy. Such a policy is
separate work with explicit ownership and billing disposition. Proof polling and
verification may continue against a recovered existing job. No automatic retry
through a non-deduplicating endpoint is supported.

## Mandatory history boundary

Before any new operation intent or effect, acknowledge the next-sequence protocol
record. Its bytes are `SSCJ4 ` followed by compact sorted-key JSON with `kind` equal
to `controller_protocol`, `version` equal to 4, the next integer `seq`, and `requires`
equal to `["native_operation_ownership_v1","preparation_abort_v1"]`. Append one
newline. There is no JSON-only mirror. Identical records have identical bytes in
Python and TypeScript. The acknowledged journal prefix is not rewritten.

New readers accept existing supported SSCJ3 history but must acknowledge SSCJ4
before activating these effects. Readers reject unsupported mandatory features,
duplicate fields, wrong sequence or an unframed protocol record. Existing readers
must reject the actual new floor with zero native/store effects. This floor
protects controller history; it cannot retroactively upgrade a bootstrap or an
unauthenticated native endpoint. Signed package/native capability checks and the
separate bootstrap compatibility transition remain prerequisites to selection.

Ordinary operation records after the floor use `kind: controller_operation`,
`version: 1`, their journal sequence, operation ID/kind, immutable request digest,
bindings, native instance/generation, outcome and result revision/evidence digest.
Results are append-only. A prepared record cannot erase acceptance; completion or
terminal_no_effect is immutable, and contradictory terminal records refuse.
The ordinary record has exactly the keys `seq`, `kind`, `version`, `operationId`,
`operationKind`, `requestDigest`, `bindings`, `nativeInstance`, `generation`,
`outcome`, `resultRevision` and `evidenceDigest`. The outer `kind` and `version` are
`controller_operation` and `1`; `operationKind` is one of `pending_set`,
`pending_clear`, `sync`, `park`, `unpark`, `commit_local`, `broadcast` or `prove`.
Digests, operation IDs and native-instance identities are 64 lowercase hexadecimal
characters. Bindings contain the exact canonical domain inputs acknowledged before
dispatch. Evidence digests hash canonical result evidence, excluding the digest
field itself; they bind the outcome and result revision to the request digest.
Every operation record freezes a nonnull native instance and generation
before dispatch. Generations and nonnull result revisions are positive safe
integers. Result revision/digest may be null only before an authoritative result
is known; accepted and terminal results require both. Status or retirement queries
use the current caller authority while retaining the original operation generation;
they never rewrite that binding to obtain a new send. Unknown is a controller
knowledge state that cannot
replace or downgrade acknowledged accepted/terminal evidence. It grants no effect.

Database tables are projections of acknowledged records. Exact database migration
and native storage layout may be chosen by their implementation PRs provided they
preserve these bindings and pass restart/restore and historical-reader tests.

## Implementation order and acceptance

The separate specification PR changes requirements only. It neither selects a
controller nor grants acceptance of unresolved defects in the frozen release.
No new named-case identifiers are introduced here. Implementations must add the
corresponding executable regressions with their effective lifecycle changes;
case discovery is never substituted for passing execution.

First port strict native facts and the official verifier boundary in a bounded
TypeScript/Effect PR without runtime selection. Use official
`@spacesprotocol/libveritas`, pinned to native version 0.4.4 for this source.
Existing two-fixture/ten-check Node evidence is preliminary. Exercise every API
used by the slice, production verification options, exact certificate bytes,
malformed/trailing data, substituted anchors and wrong recipients. Scoped fixture
agreement does not establish complete libveritas parity or native acceptance.

Native operation/fencing and store closure capabilities precede their effectful
controller callers. Proving, coordinated checkpoint/process ownership, send and
recovery, observation/certificates, publication and supersession follow in small
PRs with their own native/process tests. Keep the Python implementation as the
comparison reference until the TypeScript slice passes equivalent native scenarios
and specified negatives; then remove the replaced Python, retaining Git history.
Runner/recovery, deployment and tooling follow. Bootstrap remains a separate PR.

For unchanged behavior, Python/native and TypeScript/native outcomes must agree.
Known unsafe frozen outcomes remain negative controls, not expected behavior for
the successor. A contract-dependent change records the old result, the specified
new result and its native regression explicitly. Keep those changes separate from
pure translation PRs so a port discrepancy cannot conceal a design change.
