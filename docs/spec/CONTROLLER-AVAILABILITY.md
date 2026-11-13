# Preparation recovery and sent-batch availability

This lifecycle amendment follows the audit of `8bb7312`. It applies to the
selected Python controller and TypeScript preparation library. Payment
policy is unchanged.

## Completed-owner abort

The Python runner exposes `abort-preparation <bid>` and the TypeScript library
exposes `abortPreparation(bid)`. Both retire the entire uncommitted batch as
`rebuilt`, without a successor. Orders retain their store status; converted
orders can enter a fresh batch. Abort does not refund, unissue, roll back,
park, sync, commit or broadcast.

Abort requires live valid controller history and completed restore replay and
reconciliation. It needs an exact retained owner with no unresolved request,
or acknowledged abort progress. All historical copies must share the frozen
identity and have no root, entry, issuance intent, attempted send, transaction
bytes or ID. A local-commit intent refuses even without a root. Native chain
and pipeline heads must equal the frozen prior root. Members must be absent
or staged with their exact scripts; committed or foreign members refuse.
Store bindings and the frozen digest must match, with no issued member.
Batchability is deliberately unnecessary: depth loss or cancellation is a
reason this exit is needed.

Before pending clear, the controller acknowledges a permanent
`preparation_abort` record. Its exact fields are `seq`, `kind`, `version:1`,
`bid`, `space`, sorted `members` and `digest`. It requires matching completed
ownership and occurs once per batch. Afterward only pending-clear effects
are permitted. Ordinary stage, commit and release cannot resume that batch,
including from an older database. Reacquiring its ownership is invalid.

Clear uses the existing intent, live readback, one request and confirmed
response protocol. An explicit acknowledged completion allows ownership
clear. A completed false acknowledgment permits a new request. A lost or
invalid response retains the unresolved operation and cannot be retried.
An already acknowledged clear is read back rather than repeated after a
crash. Native/store checks run again before retirement. The abort marker
survives a crash between owner clear and final batch acknowledgment, allowing
only abort completion.

Both controllers understand this event. The [mandatory protocol amendment](CONTROLLER-PROTOCOL.md)
now acknowledges a framed record before abort begins, making JSON-only older
readers refuse. Package metadata enforces the corresponding one-way journal
upgrade. Compatible ordinary JSONL envelopes do not qualify a downgrade or
alternating writers. No new installation package is qualified.

## Sent-batch operations

Python watch, transaction capture, identical-byte rebroadcast, certificate
verification, publication and delivery confirmation may proceed through an
unrelated retained owner, including an unresolved request. They still require
valid live preparation history and completed restore replay/reconciliation.
With retained ownership, the target must have an existing root and transaction
ID, an attempted issuance intent, and matching live acknowledged identity,
members, digest, delegate, entry and transaction ID. The owner must have a
different batch ID and disjoint order membership.

This supplies no signing or first-send permission. Rebroadcast retains exact
journaled transaction/ancestor bytes, store arm and supersession checks.
Watch retains coherent chain/store observations. Certificate and publication
retain libveritas verification, exact recipients, final covered roots and
current store acknowledgments. Changed chain, invalid certificate, overlap,
journal outage, missing binding and incomplete restore still refuse.
Supersession observation can proceed; new supersession decisions stay fenced.

Freeze, stage, commit, prove, checkpoint, snapshot, first-send, unsent release
and restore mutations keep their fence. The completed-owner abort above is
the only new preparation recovery authority.

## Remaining unknown outcomes and evidence

No HTTP status alone proves no effect: pinned sync can mutate partially
before failure. An unresolved request still needs a protocol establishing
that the original cannot execute later and reconciling exact native/store
state. Empty pending readback and journal editing supply no such authority.
Post-arm read failures and durable prover-submission ownership remain open.
Broadcast still assumes the supported sole native writer rather than an
atomic expected-root endpoint.

Python tests cover ineligible members, lost clear replies, completed false
acknowledgments, older databases, native-ahead state and journal failures.
TypeScript integration tests use real store HTTP, SQLite, JSONL and process
exit 9 in both implementations. Watch and publication tests now retain an
unrelated unresolved owner while testing positive and negative outcomes.
Their native/verifier services are recording fixtures.

The native harness separately uses real pending HTTP and injected reply loss,
cancellation followed by the shipped abort command, and real libveritas/relay
delivery for an earlier sent batch while a later request stays unresolved.
Receipts bind exact source hashes. These are locally produced native results;
CI's Core regtest job does not repeat the full native-stack scenario.

The [qualified run receipt](../../regtest/runs/preparation-availability-qualified-20261113T104905Z-cc7283.json)
passes 45 required steps and binds 146 source files, including the abort and
sent-batch guards. Earlier runs predate final readback tightening and are not
used to qualify this successor.
