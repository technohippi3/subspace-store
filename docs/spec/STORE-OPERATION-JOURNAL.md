# Store operation journal format

## Status and scope

This proposed format closes the store-history prerequisite identified in
[the controller operation wire contract](CONTROLLER-OPERATION-WIRE.md). It changes
no runtime, database, journal, package or bootstrap. Existing storage and named
case expectations remain effective. Implementation must land with its governing
model, lifecycle tests and qualified readers before activation. This document
introduces no named case, skipped test or legacy-history adoption permission.

The first dormant [envelope codec slice](STORE-JOURNAL-CODEC.md) implements only
byte custody and structural encoding/prefix checks. It does not qualify a backend,
operation/domain validator, activation or the broader proposed capability.

The current logical Entry version is one, even though the signed package already
uses storeJournal schema two for its existing recovery transport. These are
separate version namespaces. The new logical Entry version is two and the literal
frame is `SSSJ2 `. A package selecting it must advance storeJournal to three;
reusing the current signed schema two would leave old bootstrap compatibility open.

## Exact envelope and bytes

An Entry has exactly `{version,store,seq,previous,changes,hash}`. store is the existing
lowercase UUID matching `[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}`; it never changes
within a stream. seq is a positive safe integer, contiguous from one; the existing
remote head limit of 1000000 also applies. previous is null only at sequence one,
otherwise the immediately preceding Entry's embedded hash. hash is Hex32.

Each changes element has exactly `{kind,key,value}`. The array is nonempty and
retains transaction order. kind matches `[a-z][a-z_]{0,31}`, key is a nonempty string
of at most 256 characters, and each `(kind,key)` occurs once per Entry. Ordinary
application kinds retain their governing typed schemas. Protocol kinds below
have exact additional schemas. Unknown kinds, unsupported versions and invalid
whole-projection relationships refuse before publication or external effects.

For version one, preserve the existing hash algorithm: SHA-256 of UTF-8
`JSON.stringify([1,store,seq,previous,changes])` with the original parsed change
object property order. Preserve every existing plaintext payload byte, sequence
and embedded hash. Version-one parsing follows the existing codec, including its
accepted duplicate-key, whitespace and exponent spellings; version-two lexical
strictness is not retroactive. Do not JCS-reencode the old prefix, strip whitespace or
renumber it to create a new history. A legacy retry uses its retained original
payload rather than inventing an equivalent serialization.

For version two, the embedded hash is SHA-256 of UTF-8 JCS of exactly
`[2,store,seq,previous,changes]`. hash is not in its own preimage. The authoritative
payload P is exactly ASCII `SSSJ2 ` followed by UTF-8 JCS(Entry), with no newline,
BOM or extra whitespace. Require valid UTF-8, well-formed Unicode, unique object
keys and byte-for-byte canonical encoding. Do not normalize Unicode or sort the
changes array. The wire contract supplies JCS/scalar definitions. Version-two
metadata and new operation objects retain their stricter raw-integer rules;
unrelated ordinary application values retain their existing finite-number/typed
rules. New changes that cannot be JCS-encoded refuse, never silently normalize.

Every post-floor Entry uses version two and P. Bare JSON version two, a framed
version one, an extra/duplicate floor, or a version-one successor after the floor
is invalid. Legacy versions cannot be smuggled through a new envelope. Prefix
validation includes envelope/sequence/hash, typed changes and complete domain
relationships; checking only a transport digest is insufficient.

## Floor and history transition

The first version-two Entry is a dedicated singleton transaction, with exactly
one change: kind `store_protocol`, key `required`, and value exactly
`{version,requires,installation,authorityIdentity,capabilityDigest}`. version is two,
requires is exactly `["store_operation_ownership_v1"]`, installation is Installation,
and authorityIdentity/capabilityDigest are Hex32. These bind the configured stable
store Authority to this existing UUID stream; they are not credentials. Each store
Request's service, installation, stable identity and capability digest must match.
Context.networkGenesis must match the qualified installation's existing Core identity.

Its seq is the next sequence and previous the untouched last version-one embedded
hash, or sequence one/previous null for an empty stream. No business mutation,
operation admission, arm grant or pending change is coalesced with this floor.
It must be durably acknowledged off-host before later new operation admission.
The protocol record is permanent; no overwrite, deletion or downgrade is supported.
A future incompatible capability requires its own reviewed version transition.

Activation is explicit maintenance: exclude old store/controller processes and
workers, pause value effects, establish exclusive ownership, settle all local
outbox uncertainty, validate the full acknowledged history and qualify every reader.
A mere version-one database open is not an upgrade. A fresh quarantined working
database uses store_meta.version two, the same UUID and restored=1, preserving
original outbox payloads and acknowledged prefix. Append/confirm the floor through
that owned stage, then reconcile and explicitly select a separately published new
database path. Never overwrite the serving database or discard its sidecars.
No listener/value effect starts from an unacknowledged floor or incomplete stage.

A crash leaves the maintenance hold in force until exact floor readback and stage
identity resolve it. After the floor exists, an old database cannot resume the
old writer. A local unacknowledged floor also cannot be abandoned in favor of an
old writer; the protected maintenance hold spans that gap. Supported restart/restore
uses a fresh unpredictable authority incarnation, not one copied from this journal.
Absence of an old-incarnation request remains unknown under the recovery contract.

Existing application history is not converted into new operation/Grant records.
Legacy unresolved arms, pending ownership and one-use requests lacking the required
bindings remain held. Only qualified settled history and fresh operation identities
can enter the new capability; this specifies no arbitrary import or forced clearance.

## Exact protocol changes

All value field sets below are exact. Request, Result, ResultRef, Context,
StoreArmRequest, Grant and TerminalUnused are the wire-contract types. Result
hashes exclude only their own evidenceDigest; no payload/Entry digest is inserted
into a Result, Grant or TerminalUnused preimage. Confirmation stays outside values,
avoiding any receipt/hash cycle.

| kind | key | value |
| --- | --- | --- |
| store_protocol | required | The singleton floor value above. |
| store_operation | operationId + `:` + canonical positive revision | `{version:1,request,result}`; result revision and immutable request binding agree with the key. Only the four store operation kinds belong here. |
| store_native_evidence | evidenceDigest | `{version:1,request,result}`; the exact NativeBroadcastRequest and its native terminal_no_effect Result. |
| store_reservation | armId | The exact StoreArmRequest; its operationId equals armId. |
| store_entry_guard | EntryId | `{version:1,armId,reservationDigest}`; digest of that exact StoreArmRequest. |
| store_grant | armId | Exact Grant, whose arm/entry/native request binding matches the reservation. |
| store_terminal | armId | Exact TerminalUnused, matching reservation and original grant history. |
| store_pending_owner | pendingOwnerId | `{version:1,context,state,operation}`; Context, `active` or `retired`, and ResultRef for the completed pending operation producing this state. |
| store_pending | global | `{version:1,ownerId,orders,operation}`; Hex32|null, sorted OrderId array (possibly empty), ResultRef|null. |

Operation, native-evidence, reservation, entry-guard, grant and terminal keys are immutable once
written, including against identical re-emission at another sequence. An exact
retry returns the retained result and fresh confirmation of its original sequence;
it appends no duplicate record or business projection. Operation revisions start
at one, increase contiguously and retain identical Request bytes/digest. At most
one revision of an operation occurs in one Entry. Accepted may become completed
or terminal_no_effect; those terminal results never change. Store version one of
this capability has no partial business commit: the local domain change and
completed Result are one SQLite transaction. Accepted records alone authorize no
grant or pending projection. Preventative reservation bookkeeping is retained.

Complete operation history is authoritative, not a latest-value shortcut. Every
historical ResultRef resolves its exact retained revision, including after a newer
revision or authority restart. Never rewrite its original Authority to match the
current caller. A projection/index may accelerate lookup but must reproduce the
same immutable history and cannot erase acceptance or tombstones.

The entry guard permits one prospective arm/reservation per EntryId, permanently.
It is created with the reservation, including count-zero retirement of an absent
entry. Different bytes/arm IDs cannot reuse that entry. A same-delegate successor
uses a fresh EntryId and armId after the recovery contract's old-ownership checks.
An old entry-create/reserve cannot bypass a terminal guard.

Pending-owner context never changes. State may progress active to retired, never
back. An absent owner may become retired only after the coordinator's complete
assigned-request reconciliation and the store clear CAS. Its marker is permanent.
Before the first new pending owner, store_pending absence means only the qualified
empty initial projection; it is not no-effect evidence for an absent operation.
A cleared global value has null ownerId, empty orders and its clear ResultRef.
An active owner has nonnull ownerId even if arm retirement has removed all of its
own pending members. Empty orders do not retire ownership or admit a successor.
Its current order set is a subset of its immutable Context members; fresh native
admission still requires the exact set it intends to act on. The global operation
reference names the completed set, clear or arm_retire that produced this version.
Each global-set mutation also writes the matching existing registry_pending/global `{version:1,orders}` projection atomically.

An accepted pending_set record is itself a pending-owner reservation, even before
a completed owner/global projection exists. The complete verified operation history
must fence that owner until live-confirmed clear/retirement; a terminal_no_effect
operation does not alone retire its owner. Another owner cannot enter during this
interval. Looking only at store_pending or completed owner rows is insufficient.
The coordinator still accounts for all assigned requests, including delayed requests
not yet accepted. The matching later clear can create the absent owner's retired
marker after that reconciliation, without inventing an earlier active set.

Historical pending Results and their live confirmations do not prove an owner is
still active. Native/store dependent admission must also check the current global
owner, exact Context/order set and retired-owner markers from the confirmed prefix.
An old active result cannot replace a newer clear or successor owner. A historical
retry changes neither the current global projection nor another owner's orders.

## Atomic operation projections

Admission validates bounds, all bindings, current incarnation/generation/lease and
expected state before mutation. Read-only precondition checks cannot hide separate
state-changing observations. Any ordinary observation command has its own existing
acknowledged history; it is not an unrecorded side effect of a failed pending/arm
operation. Validate the whole proposed projection before one local transaction
publishes its typed changes, outbox payload and operation result.

A completed pending_set atomically records its Result, active owner marker,
store_pending and registry_pending for the exact Context members. A completed
pending_clear records its Result, retired owner and the matching cleared global
set. A foreign current owner/digest mismatch refuses before changing either set;
an exact old retry returns history only. No owner transfer before live confirmation.

A completed arm_reserve atomically records reservation/guard if not already
present, its one Grant, the corresponding existing entry_arm projection, and its
completed Result. The bound issuance_entry/orders must already match. A preceding
accepted revision may record reservation/guard and that accepted Result without
any Grant. Fresh grant admission still rechecks all domain/native-request bindings.
Only confirmed completed/grant history can authorize the native bound operation.

Count-zero arm_retire atomically writes missing reservation/guard, the original
arm_reserve terminal_no_effect revision, TerminalUnused and the retire completed
Result. Original no-effect needs continuous-origin or positive accepted-record
proof under the recovery contract; an old-incarnation absence cannot invent it.
If the original terminal_no_effect record already exists, retain it unchanged.
No Grant/entry_arm or fictional issuance_entry may be created. An absent entry
changes no orders. An existing unarmed entry uses the same exact own-order release
projection below to release exactly its own existing locks.

Count-one arm_retire retains the original Grant, entry_arm and reserve Result.
One transaction writes TerminalUnused, retire Result and exactly the recovery
contract's own-order release/pending projection, also used for an existing count-zero
entry. Only its own still-issuing orders may become converted. Preserve addresses, reserves, history, cancellation, foreign
pending ownership and successors. An absent entry changes no orders. New domain
validation treats store_terminal as tagged terminal_unused for both a count-zero
existing unarmed entry and a count-one retained-arm entry. Each becomes non-live
without violating the new own-order projection. It does not write a conflicting
ordinary entry_closure or erase a consumed grant. Existing named cases stay unchanged
until the new validator/model and runtime tests land with implementation.
The same guard rejects all later arm/create effects for that entry. There is at
most one completed arm_retire request per arm; a retry uses that original ID/digest.
A different retirement ID cannot reapply a terminal arm's domain projection.

Retirement obtains and authenticates its exact native no-effect result before the
local CAS, outside the store write lock. Neither a free-text claim, native timeout,
local worker stop nor store journal absence substitutes for it. The no-effect
original-reserve revision in a count-zero transaction has drainRevision equal to
that Entry's seq. Protocol retirement never recursively creates another operation ID.

Removing own pending members updates registry_pending and store_pending atomically
only when the active owner/context is that entry's owner. Retain its nonnull owner
and active owner marker, even when no members remain; only the later reconciled
pending_clear retires it. The global operation reference becomes this arm_retire
ResultRef. Foreign owner/set/operation references remain byte-identical.

Store-local Results, Grants and TerminalUnused objects referenced by a completed
mutation exist in that Entry or its already validated store prefix. Native no-effect
references instead resolve to the exact store_native_evidence capture in that Entry
or prefix. Its result.evidenceDigest equals its key; all fields of the native
ResultRef, requestDigest, original Authority and terminal state/effects agree. Its
Request bytes equal the reservation's complete prospective native broadcast Request,
not merely an unrelated operation with the same root or an opaque digest.

The store itself obtains that native record over its configured authenticated
native channel before the local CAS, validating the owning identity, capability,
original request/result hashes and arm/context bindings. Current caller authorization
is separate from historical origin. An unanswered/missing status cannot produce
evidence; caller-uploaded objects, unauthenticated responses and hashes alone cannot
create a native-evidence record. Credentials are never stored in the capture.

The acknowledged capture and completed retirement are the store authority's retained
historical statement that this authentication and validation succeeded. They are
not a native signature, new tombstone or authority for another operation. Offline
replay may validate the captured bytes, exact hashes and relationships to reconstruct
that historical store disposition without a live native RPC. It cannot manufacture
no-effect for an uncaptured/missing record or relax fresh restore/quarantine gates.
Qualified native no-effect promises remain permanent under the recovery contract's
custody/incarnation assumptions; this adds no hostile-root or arbitrary-import claim.

No later append may retroactively supply missing evidence. A domain change without
its matching result, or result without its required domain projection, refuses
during replay as well as admission.

## Payload custody and confirmation

Every qualified journal API carries a validated record view with both the exact
plaintext payload bytes and its decoded Entry. Read, append/retry, restore, indexes,
confirmation and checkpoint retain that association. Entry-only APIs and reconstructing
bytes with JSON.stringify(decoded) cannot qualify this format. The decoded object
never substitutes for the original payload or proves its byte identity.

SQLite outbox.payload stores exact P for version two and the retained original
version-one plaintext bytes as lossless UTF-8 text, without added framing. Protocol
projections and any derived indexes must reproduce these verified original records;
they are not an alternative bare-JSON outbox. JSON SQL functions cannot parse SSSJ2
directly: history/acknowledgment lookup, reconcile, restore, inspection and checkpoint
must use the qualified byte-carrying codec or its verified derived index.

For a legacy local file, its payload view is the complete original file bytes minus
at most one final LF if present. Every other byte, including other whitespace,
duplicate/exponent spelling and property order, stays intact. This defines file
framing without rewriting the file. Remote plaintext and outbox payloads remove
no LF or whitespace. At activation, each local retained payload must equal the
corresponding off-host payload view byte for byte, as well as match the existing
UUID/sequence/embedded-hash chain. A matching embedded hash alone is insufficient.
Unavailable original bytes, non-lossless UTF-8 or differing local/off-host bytes
keep maintenance held; do not rebuild a stage from reserialized objects or silently
normalize a legacy history. A separate reviewed migration would be needed for a
history outside these eligibility constraints. Preserve all original evidence.

New local immutable files keep the sequence filename and contain exact P plus one
LF. A version-two reader requires and removes just that one physical LF, not
arbitrary whitespace. Its off-host plaintext, SQLite payload and transport SHA
bind P without LF. Old prefix files and remote payloads are never backfilled.

Confirmation.sequence is the Entry containing the particular operation revision,
not the latest projection's sequence. recordDigest is SHA-256(P), distinct from
the embedded hash. A completed arm status confirms the Entry holding its Grant or
TerminalUnused; a reserved status confirms its reservation/accepted record. The
full current prefix must also validate related guards/results and current ownership.
liveHead is the actual matching current off-host head or null when unavailable;
acknowledged=true requires exact P readback, complete lineage and the existing
local/remote head coherence checks. Historical SQLite acknowledgment alone is false
as a live proof. A failed read gives false/null, never no-effect or fictional absence.

The recovery client J1/J2 encryption/chunk envelopes are a separate layer. Their
existing contexts, immutable publication, plaintext SHA and encrypted remoteSha256
remain unchanged; remoteSha256 is not recordDigest. The client treats P as opaque
bytes. The store/replay/checkpoint consumers validate its logical sequence, UUID,
chain and typed effects. The helper's filename/AEAD sequence alone is insufficient.

The complete framed P is at most 16 MiB. Existing 8192-entry/16-MiB plaintext pages,
512-MiB replay-prefix, 1000000-head and 24-MiB local-message limits stay unchanged.
Account for the six-byte prefix, full envelope and base64/JSON overhead before
accepting work. Each new protocol change value is at most one MiB. Invoke/query/controller
records also must fit their wire-contract one-MiB bounds. Admission must reserve space for every
required terminal/status variant; refuse before accepting an unrepresentable effect.
Do not truncate a Result, split one atomic Entry across sequences, or extend limits.

## Compatibility and qualification

The activating database has store_meta.version two; application protocol records
require signed applicationRecords three. The signed storeJournal value is three,
not the current two. Existing bootstrap verifies exact schema dictionaries, so it
must reject this future profile before extracting/executing payload code. Any
combined controller activation also requires controllerJournal four. Define and
qualify the supported complete dictionary in the separate bootstrap/package PR;
this format does not relax schema equality, supply an automatic upgrade, or assume
permanent Python. A Python-free bootstrap still needs separately trusted Node first.

All store, FileJournal/SshJournal, encrypted transport, application decoders,
replay/restore, reconciliation/maintenance, checkpoint and bootstrap data readers
must qualify the actual framed history before selection. Old HTTP pending/entry
shapes refuse after activation even with authentic old credentials. Protected
maintenance and process ownership exclude raw/background writers; no mirrored old
stream, record deletion, or older database can bypass either compatibility floor.

Implementation must supply independently expected golden histories: untouched
version-one prefixes (including non-JCS key order and a greater-than-one-MiB Entry),
first floor at one/after history, all protocol records/revisions, count-zero/one
retirement, owner transfer, exact receipt digests and file LF handling. Negatives
include duplicate keys, noncanonical UTF-8/JCS/numbers, unsupported frames/schema,
wrong UUID/sequence/hash, v1 after floor, changed/repeated immutable keys, missing
or noncontiguous Results, incomplete atomic projections, stale active-owner facts,
false confirmation, overflow at every framing/page boundary and old-reader opens
with old databases. Old readers must fail before listener, local projection write,
append or value effect. Real process crashes, durable publication/readback, late
requests, restore and native concurrency remain separate integration requirements.
Golden vectors and this specification do not implement those guarantees.
