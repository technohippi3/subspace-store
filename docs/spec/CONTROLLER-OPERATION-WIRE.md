# Controller operation wire contract

This proposed version-one format accompanies
[controller recovery contracts](CONTROLLER-RECOVERY-CONTRACT.md). It is not yet
implemented. All object field sets below are exact and required; only explicit
`T|null` permits null. Unknown/duplicate fields refuse recursively. Database layout
is an implementation choice; external bytes and evidence are not.

## Canonical encoding and scalar types

Request/result hash preimages use UTF-8 [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html),
including its recursive property ordering, escaping and invalid-surrogate rejection.
Do not Unicode-normalize strings. Reject noncanonical wire bytes and duplicate keys.
Before canonicalization, reject numeric literals outside `(0|[1-9][0-9]*)` or the
safe integer range; `1.0`, exponents, negative zero and lossy parsing are invalid.
This narrower protocol rule is not removed by JCS number canonicalization.

| Type | Exact constraint |
| --- | --- |
| Count | Integer 0..9007199254740991; Positive excludes zero. |
| Hex32 | Exactly 64 lowercase hexadecimal characters. |
| EntryId | Exactly 32 lowercase hexadecimal characters; distinct from arm/operation IDs. |
| OrderId | `o[1-9][0-9]{0,15}`, preserving the existing store identifier bound. |
| Installation | `[A-Za-z0-9][A-Za-z0-9_.-]{0,99}`, exact configured spelling, no case/alias conversion. |
| Label / Space / Handle | Label matches `[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`; Space is `@` + Label; Handle is Label + Space. Exact ASCII spelling only. |
| Bytes / Script | Bytes is nonempty lowercase even-length hex, at most 1 MiB decoded. Script is exactly `5120` + Hex32 whose x-only public key is below the secp256k1 field modulus and lifts to a curve point, preserving existing P2TR admission. |
| Delegate | Hex32 + `:` + canonical decimal index 0..4294967295, with no redundant zeros. |
| FeeRate | Positive decimal string `(0|[1-9][0-9]*)(\.[0-9]*[1-9])?`, at most 32 characters, no exponent; preserve configured value/caps, never round to another rate. |
| JobId / ProofKind | JobId matches `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`. ProofKind matches `[a-z][a-z0-9_-]{0,63}` and is supported by the bound provider contract. |

A new operation invocation, reply or controller operation record, including nested
values, must fit a proposed 1 MiB encoded bound. This is not an existing universal
store journal limit. Existing store transactions and their typed change values keep
their current bounds, including the 16 MiB record/page transport bound. The separate
store-format prerequisite below must settle framing overhead without truncation
or a transport-limit extension. The raw-integer rule above applies to new operation
objects, not unrelated legacy typed change values.
Members/orders/labels have at most 1000 elements; inventory arrays at most 10000;
ancestors at most 128. Aggregate bounds still apply. Set-like arrays are unique and
sorted by ASCII identifier; arrays explicitly described as dependency order retain
that order. Empty arrays are allowed only where stated. Independent golden vectors
must cover every operation/result variant and lexical rejection before implementation.

## Shared objects

`Authority` has exactly `{service, installation, identity, incarnation, generation,
owner, capabilityDigest}`. service is `store` or `native`; installation is Installation;
identity is a stable configured Hex32, incarnation a fresh startup Hex32, generation
Positive, owner the authenticated coordinator lease-holder Hex32, capabilityDigest
Hex32 binding the reviewed service contract/inventory. The public tuple is not a
credential. Current caller credentials/lease are transport authorization, separate
from an immutable request's original Authority.

`Member` is `{order, handle, script}`. `Context` is `{networkGenesis, space, batch,
priorRoot, memberDigest, members}`: genesis is the verified configured Bitcoin
block-zero Hex32, never a main/mainnet alias; batch is `b[1-9][0-9]*` (max32 ASCII);
priorRoot is Hex32|null, memberDigest Hex32 and members a nonempty Member array,
sorted by order with unique handles. Member.order/handle/script use their named types.
memberDigest retains the existing sorted tuple/spaced-ASCII digest in
CONTROLLER-PREPARATION; it is not silently reinterpreted as a JCS digest.

`Head` is `{root, index, txid, pending}` with Hex32|null roots/txids, Count|null index
and boolean pending. Only successful explicit absence is null. Per-operation
consistency/readback constraints remain those in CONTROLLER-PREPARATION; errors
cannot manufacture empty heads. `ScopedHead` is `{space, head}`.

`Transaction` is `{txid, raw, ancestors}`; raw is Bytes, ancestors is an array of
`{txid, raw}` in dependency order with unique txids; ancestors may be empty. Parsing the real Bitcoin
transaction must establish its txid; hashing witness bytes naively is insufficient.
All bytes/ancestors must bind the intended delegate/root before recovery permission.

`Provider` is `{identity, contractDigest, pricingDigest, deduplicating}`: first two
are Hex32, pricingDigest Hex32|null (null only for an explicitly unbilled contract),
and deduplicating boolean. A configured free-text provider URL is not its identity.

`Request` is exactly `{version, operationId, operationKind, authority, bindings}`:
version is 1, operationId Hex32, authority Authority, bindings exactly `{context,input}`.
The table fixes service/kind and input. requestDigest is SHA-256 of JCS(Request),
not a field of its own preimage. Transport auth/result/digest wrappers are excluded.
`OperationRef` is `{operationId, requestDigest, authority}`. `ResultRef` adds exactly
`revision` (Positive) and `evidenceDigest` (Hex32). A supplied reference alone grants
no permission: resolve it against the authenticated owning service and verify it.

`PendingRef` has exactly `{operationId,requestDigest,authority,revision,
evidenceDigest,confirmation}`: a ResultRef for a completed pending_set in the same
context, plus its live store Confirmation. `CommitRef` is a ResultRef for completed commit_local
in that exact context. `ArmRef` is `{storeIdentity, entry, armId}` (Hex32/EntryId/Hex32).
`NativeBroadcastRequest` is only the broadcast row below, not arbitrary recursive Request.
`StoreArmRequest` is only the arm_reserve row; its operationId equals its armId.

## Closed operation kinds and input objects

| Kind/service | Exact input fields and additional constraints |
| --- | --- |
| pending_set / store | `{pendingOwnerId, orders}`: Hex32 owner, nonempty OrderId array exactly matching Context.members. |
| pending_clear / store | `{pendingOwnerId, expectedPendingDigest}`: both Hex32; CAS the same owner/current set. A historical retired-owner retry cannot mutate another owner. |
| arm_reserve / store | `{entry, armId, nativeRequest}`: EntryId, Hex32, NativeBroadcastRequest. Context, entry/arm/native binding must agree exactly; prospective native digest is computable before grant. |
| arm_retire / store | `{reservation, nativeNoEffect}`: exact StoreArmRequest and ResultRef for its native broadcast terminal_no_effect. Requires authenticated resolution of that result. |
| sync / native | `{pendingOwnerId, pendingResult, expectedHeads}`: Hex32, PendingRef, sorted nonempty ScopedHead array covering every loaded space the global sync can mutate. |
| park / native | `{pendingOwnerId, expectedHead, expectedStagedDigest, labels}`: owner Hex32, Head, Hex32 and nonempty Label array. Selected facts must still be staged/uncommitted; committed handles cannot be parked. |
| unpark / native | Same exact fields as park; expected member scripts/roots must match Context. |
| commit_local / native | `{expectedHead, expectedStagedDigest}`: Head, Hex32; exact unparked members/recipients, prior root and one local commit opportunity. No adoption/recommit after ambiguity. |
| broadcast / native | `{commitResult, expectedHead, delegate, feeRate, arm}`: CommitRef, Head, Delegate, FeeRate, ArmRef; nonnull matching root/index, no native txid, verified proof state and exact immutable members. |
| prove / native | `{commitResult, expectedHead, proofId, inputDigest, proofIndex, proofKind, provider, mode, original, knownJob}`: CommitRef, Head, Hex32, Hex32, Count, ProofKind, Provider, `submit` or `recover_known`, OperationRef|null, JobId|null. Submit has null original/job; recover has both and may only poll/verify/apply the positively bound existing job, never submit. |
| rollback_local / native | `{commitResult, expectedHead, unusedArm}`: CommitRef, Head, ResultRef|null for completed arm_retire. Require exact unbroadcast owned top root; if no arm ever existed, independently live-acknowledged store/controller history must prove that. No unknown send/arm or root mismatch may roll back. |
| attach_txid / native | `{original, commitResult, expectedHead, transaction}`: original broadcast OperationRef, CommitRef, Head, Transaction. Independently verify positive transaction/delegate/root evidence; attach only that txid to the exact restored commitment. No signing/send or absence-based adoption. |
| rebroadcast_known / native | `{original, transaction}`: original broadcast OperationRef and Transaction, with a retained irrevocable dispatchClaim=true binding those signed bytes, or independent positive known-send evidence, plus current live store/supersession guards. No new arm, fee, signature or logical first-send authority. |

expectedPendingDigest hashes JCS(sorted order-ID array). expectedStagedDigest hashes
JCS of sorted `{label,script,root,index,parked}` facts for the complete staged inventory;
labels, script and Head scalar types apply. No pagination/count-only summary qualifies.
ProofId is SHA-256 of JCS exactly `{installation,networkGenesis,space,root,
commitmentIndex,inputDigest,proofIndex,proofKind,provider}` using the immutable
context, expected head and Provider object. It excludes batch IDs, result-reference
metadata and request generation/incarnation. Existing claims for the same proof
inputs remain binding even if provider/contract/pricing fields change; version one
provides no replacement-job authority. Full live controller history must be checked.
An old absent native ledger cannot justify fresh submit.

Rollback/attachment are narrow recovery mutations, not whole-tree deletion or
in-place ledger restore. Existing entry open/known-unarmed close retain their
specified EntryId idempotency plus activated store incarnation/terminal-marker checks;
this document adds no generic operation framework for order/refund endpoints.
Full restore and lease transfer follow the maintenance protocol, not a hidden kind.
Unsupported proof imports or other mutation primitives remain disabled pending their
own explicit contract. No legacy endpoint fallback supplies a missing kind.

## Result preimages, partial effects and confirmation

`Result` has exactly `{version,operationId,requestDigest,authority,revision,state,
effects,data,evidenceDigest}`. Version1 and original request identifiers/Authority
must match. revision is Positive. evidenceDigest hashes JCS of the same object
with only evidenceDigest removed. Human messages/credentials are not evidence.
state is `accepted`, `completed`, `partial` or `terminal_no_effect`; effects is
`possible`, `complete`, `partial` or `none`, respectively. Unknown is controller
knowledge, not a fabricated authoritative result. Terminal records are immutable.

For accepted, data is `{}` except: broadcast has `{dispatchClaim,prepared}` (boolean,
Transaction|null), prove has `{dispatchClaim,proofId,jobId}` (boolean,Hex32,JobId|null).
A true broadcast claim requires nonnull prepared Transaction. The claim is fsynced
before the external call and is irrevocable: terminal_no_effect is forbidden after
it, even if the call never reached the wallet. Those exact authorized bytes may
be recovered, without new signing/permission. Prover claim=true without provider
idempotency cannot be resubmitted. Missing responses/jobs never reset either claim.
A completed first-send duplicate returns data only.

For terminal_no_effect, data is `{reason,drainRevision}`: reason `never_accepted`
or `cancelled_before_effect`, drainRevision Positive. The originating-incarnation
continuity and no-past/no-future-effect rules are mandatory, not inferred from shape.

For partial, data is `{stopped,scope,affectedSpaces,changes,observedHead}`: stopped
is true, scope `installation` or `space`, spaces a sorted Space array, observedHead
Head|null, changes a sorted array of `{space,label,beforeDigest,afterDigest}` with
Space|null, Label|null and Hex32|null digests. This is an inventory pointer, not
clearance: reconcile every affected scope against full facts. affectedSpaces and
changes may be empty when the exact affected set is not yet established; this does
not certify no effect or reduce the required full-scope reconciliation. Any unaccounted late
external effect cannot use stopped=true; remain accepted/unknown. Partial is never
terminal no-effect or implicit successful completion.

| Completed kind | Exact data fields |
| --- | --- |
| pending_set / pending_clear | `{pendingOwnerId,orders,pendingDigest,ownerState}`: Hex32, sorted OrderId array (empty only on clear), Hex32 and `active`/`retired`. |
| arm_reserve | `{armId,entry,grantDigest,grantCount}`: Hex32, EntryId, Hex32 and literal 1. It describes the historical grant, not a fresh boolean permission. |
| arm_retire | `{armId,entry,terminalDigest,grantCount,releasedOrders}`: Hex32,EntryId,Hex32,0 or1, sorted OrderId array, empty when no own orders were released (including absent-entry/count-zero retirement). |
| sync | `{heads,stagedDigest}`: sorted nonempty ScopedHead array covering every loaded space and Hex32. Fresh exact per-member readback still required. |
| park / unpark | `{head,stagedDigest}`: Head and Hex32. |
| commit_local / rollback_local | `{head,memberDigest}`: Head and Hex32, with the kind's root/one-use constraints. |
| broadcast / rebroadcast_known | `{transaction}`: Transaction, bound to exact known send evidence. Prepared bytes alone cannot fabricate completion. |
| attach_txid | `{head,transaction}`: Head and Transaction, same root/index/txid. |
| prove | `{proofId,jobId,inputDigest,proofDigest}`: Hex32,JobId,Hex32,Hex32 after actual proof verification/application to the exact head. |

`Confirmation` is exactly `{sequence,recordDigest,liveHead,acknowledged}` with Positive,
Hex32, Count|null, boolean. It is separate from the immutable result/digest. For a
store result, it refers to that exact store journal record and current off-host
readback; true requires liveHead>=sequence and exact record bytes/prefix. False
never means no local mutation. For native results it is null (durable native result,
plus controller-journal acknowledgment before dependent work). No sequence/digest
may be inferred from a response code.

A result query returns exactly `{version,currentAuthority,record}`; record is null
or `{request,result,confirmation}`. Null is never no-effect evidence. Current caller
authentication can query historical positive origin records without changing them.
An invoke carries exactly `{version,request,requestDigest}`. Status/retire controls
carry `{version,original}` with the immutable Request; current lease credentials
remain transport authorization. Retire is idempotent on the original ID/digest,
not a recursively new effect ID; journal its retirement intent before dispatch.

## Store arm records and one-use projection

A durable `Grant` is exactly `{version,armId,entry,nativeOperation,nativeRequestDigest,
delegate,root,oids}` with version1, Hex32, EntryId, OperationRef, Hex32, Delegate,
Hex32 and sorted nonempty OrderId array. nativeOperation/requestDigest must match
the embedded prospective broadcast Request. grantDigest is SHA-256(JCS(Grant)).

`TerminalUnused` is exactly `{version,armId,entry,reservationDigest,grantDigest,
grantCount,nativeNoEffect}` with version1,Hex32,EntryId,Hex32,Hex32|null,0 or1,ResultRef.
Count0 requires null grantDigest; count1 retains the exact Grant. terminalDigest is
SHA-256(JCS(TerminalUnused)). reservationDigest hashes the exact StoreArmRequest.
Resolve nativeNoEffect from its authenticated authority; a caller-created object
or opaque hash alone grants no closure. Old-incarnation absent reservations cannot
be assigned a count. A terminal record is never overwritten or removed.

The store's current arm-status reply contains exactly `{version,currentAuthority,
armId,entry,reservation,grant,terminal,phase,confirmation}`. Reservation is the exact
StoreArmRequest, grant/terminal their object|null, phase `reserved`, `armed` or
`terminal_unused`, confirmation live store Confirmation. Native admission requires
armed, nonnull Grant and true confirmation. terminal_unused requires nonnull terminal;
count0 has no grant, count1 preserves it. Missing status returns record-not-found,
not a fictional reserved/unused arm. Its HTTP status alone supplies no permission.

GrantCount is history, not permission for another native ID. Same-ID native invoke
may use only the declared durable dedup contract in its still-live origin, with
identical bytes and no unresolved retirement intent. It cannot build another
transaction or grant. After authority restart use status/positive known-transaction
recovery, never rebinding the old request. Legacy `granted:false` remains unchanged
in its implemented protocol; old boolean receipts cannot be wrapped into this new
capability or an invented native identity.

## Journal floors and compatibility

Before new operation/retirement intents, append `SSCJ4 ` plus JCS of exactly
`{kind:"controller_protocol",requires:["native_operation_ownership_v1","preparation_abort_v1"],seq:N,version:4}`
and one newline to the controller stream. N is the next Positive sequence.
The prefix is literal ASCII including its trailing space; the body has no extra
whitespace. Earlier bytes are never rewritten or renumbered.

Store activation requires the separate `SSSJ2 ` incompatibility floor and exact
[store operation journal format](STORE-OPERATION-JOURNAL.md). That companion defines
the Entry/hash-chain transition, protocol change identities, atomic projections,
receipt bytes, limits and reader/package prerequisites. It is a proposed format,
not an implemented capability. The pure/read-only first slice needs no store-format
implementation. Effectful store/native/controller integration stays blocked until
the format and operation contracts are reviewed, implemented and verified together.

A controller operation record has exactly `{seq,kind,version,request,observation,
result,confirmation}`: kind `controller_operation`, version1, observation `intent`,
`receipt` or `unavailable`; intent has null result/confirmation; receipt has Result
and its required confirmation; unavailable cannot erase any acknowledged positive
revision. Retirement intent is exactly `{seq,kind,version,request}` with kind
`controller_operation_retirement`, version1. It blocks redispatch until resolved.

The store keeps operation/Grant/TerminalUnused objects in acknowledged versioned
records/projections; its database layout is free, but immutable bindings, complete
history, live-confirmation and terminal invariants are not. Both stores/controllers,
remote transport, reconciliation readers and bootstrap checkpoint parsers must
understand the actual new records/floors. Unchanged old readers must reject both
actual histories before mutation, including with older databases. Old HTTP entry/
pending requests must refuse after store feature activation even with valid old
credentials. No controller floor alone is claimed to exclude an old store.

Implementations must supply independent positive/negative canonical golden vectors
for every request/result variant and lexical/size bound, plus historical-reader,
late-request, restore, same-delegate successor and real-native concurrency evidence.
These are requirements, not tests or implemented guarantees in this specification PR.
