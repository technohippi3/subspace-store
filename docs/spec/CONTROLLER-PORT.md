# TypeScript controller entry and restart kernel

The development controller under `ts/src/controller/` composes Effect with
the existing controller batch states. Its bounded input is a preexisting
checkpointed batch with a bound root and exact sorted member IDs. It ports
the entry and first-attempt rules in `ENTRY-RECOVERY.md`, the arm boundary
in `ENTRY-RELEASE.md`, and interrupted-answer rules A20–A22. It adds no
payment rule or independent-model change.

The shipped Python controller and attended runner remain selected. This
library has no command entrypoint, polling loop, native service setup or
deployment selection. It cannot freeze, stage, prove, checkpoint, close or
rebuild a batch. It supplies neither commitment readback/rebroadcast nor
finality, certificate, publication, supersession, snapshot or whole-host
reconciliation. Those ports and their real-native/package acceptance are
required before the controller can replace Python. Full Python removal
remains the target in `PORT-PLAN.md`.

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
membership and field shapes are checked, but this kernel trusts the supplied
checkpoint digest and does not reconstruct or prove the frozen tree.

The controller retains the existing Python JSONL envelope:
`{"seq":1,"kind":"batch","batch":{...}}`. Other sequenced controller
events are preserved as opaque history. The store's DurableStore envelope
is separate. Complete prefixes require contiguous sequence numbers, valid
UTF-8, unambiguous JSON and validated batch rows. Previously read bytes
cannot change or disappear within an instance.

The local backend requires an existing dedicated directory. Append, file
fsync, directory fsync and exact readback precede acknowledgment. The
existing `<name>.down` marker refuses access. This preserves Python JSONL
read/write compatibility; it does not give that legacy plaintext format a
cryptographic origin proof across independent starts.

The remote adapter retains the recovery client's `controller` stream and
`journal-read`/`journal-append` request and acknowledgment shapes. It checks
every returned object digest and sequence over the full bounded prefix,
uses stable exact pending bytes after a lost append response, and confirms
readback before acknowledging a new batch. A transport outage never selects
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
entry or failed member returns release required while retaining state; this
slice does not perform the later close/rebuild protocol. An already armed
entry becomes uncertain and cannot grant a first send.

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

The `controller-port-*.test.ts` production tests use real SQLite and the
existing TypeScript store's authenticated HTTP listener. They cover A20–A22,
A24–A26, O16, O19 and the arm-loss portion of O23. Entry reply loss before
and after forwarding exercises the O15 boundary. Child Node processes exit
after entry identity, store entry, intent, local attempt, arm and send, then
restart over the retained files. Separate tests read Python-produced
SQLite/JSONL and read TypeScript appends using the Python Journal, reject
malformed histories/schema, and force a SQLite alert failure to prove the
uncertainty transaction rolls back as a unit.

Broadcasts and native capture are recording stand-ins. These checks establish
source-level controller/store composition and normal-process restart only.
They do not establish real Spaces sends, native-byte validity, installed
package acceptance, whole-host recovery or a production controller switch.
