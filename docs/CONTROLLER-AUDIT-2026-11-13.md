# Controller audit follow-up, 2026-11-13

An external public-source review examined PR24 at
`a2d0afb09f2ea197a0963e66088a4dae8c4ab982`. Its findings affect the Python
controller selected by the pilot and take priority over extending the
unselected TypeScript controller. Paid sales remain closed.

The subsequent [availability amendment](spec/CONTROLLER-AVAILABILITY.md) adds
completed-owner abort and permits acknowledged sent-batch work through an
unrelated preparation owner. The sections below record the earlier root
repair; the amendment supersedes their blanket fence-scope and no-exit
statements for fully completed ownership only. Unknown requests, post-arm
read failures and durable prover-submission ownership remain open.

A further [protocol and continuation amendment](spec/CONTROLLER-PROTOCOL.md)
adds an acknowledged framing boundary against older controller readers and
extends the native scenario to issue and fulfill a surviving paid member.
It also records the combined coordinator review and its non-independent scope.

## Native commitment binding

The Python proving loop, checkpoint and first-send path previously lacked
a fresh comparison between the frozen batch and the native head. The new
`controller/native_binding.py` checks the pipeline root and commitment index,
absence of a transaction ID, and exact member labels, scripts, roots and
unparked state. It checks the head again after reading members. Proving uses
these facts on each poll. Checkpoint checks before the snapshot and after
restart. First-send checks before consuming the arm and again before broadcast.
A pre-arm refusal preserves the unused attempt; a post-arm refusal preserves
uncertainty and grants no second attempt.

The restore helper `subs_holds()` alone is insufficient: members can retain
an older root while `/broadcast` selects a different latest commitment.
The upstream startup cleanup is conditional on a mismatch between its tree
and last unbroadcast SQLite commitment. It does not delete every unbroadcast
commitment on ordinary restart. Separate readback still assumes the supported
single native writer; it is not an atomic expected-root broadcast API.

Focused tests cover absent/foreign heads, changed recipients, parked members,
head changes during member reads, checkpoint restart loss and post-arm loss.
These recording tests are not native evidence. Real-native qualification must
be bound to the successor source, not inherited from earlier reports.

## Preparation fence recovery remains open

The global fence can be retained after a non-success HTTP response or after
a completed pending-set when a member becomes ineligible. It also blocks
already-sent batches' observation, rebroadcast, certificate verification and
publication. A recording HTTP 503 reproduction confirms that both watch and
rebroadcast in another space refuse. The native binding repair does not fix
this availability defect.

Recovery must distinguish three cases. An unresolved request needs proof that
the original operation cannot still execute, followed by journaled native and
store reconciliation. A definite no-effect rejection needs a documented
endpoint contract and a durable receipt proving that outcome; status codes
alone are insufficient, especially for partially completed sync. A retained
owner with no unresolved operation needs an acknowledged pending-clear and
safe abort/release path that works when a member has become ineligible.
Neither replaying the request nor editing the journal is an acceptable exit.

The fence's scope also needs operation-specific tests. Chain observation,
capture of already-sent bytes and independently verified certificate delivery
should be assessed separately from preparation mutations. Identical-byte
rebroadcast must retain its send-history, supersession and live-journal checks.
Publication must retain exact certificate and recipient verification. No
blanket bypass of restore or journal checks is introduced by this audit.

## Corrected pipeline contract

Pinned subs `4dcc923` reports `has_pending=false` for a finalized commitment
awaiting publication. The controller permits the next preparation in that
state. Both preparation specifications now say so. The negative test is
named for an unfinished pipeline, and separate Python and TypeScript tests
use the finalized-but-unpublished response shape. Publication was never an
additional implemented preparation gate.

## Qualification and review scope

The original preparation commit also amended the selected Python path. Its
source-level tests did not qualify that amendment against real native services.
New native results must identify their exact source hashes and scenario scope;
they do not replace signed-package, whole-host or buyer acceptance.

The [new native regression](../regtest/runs/audit-root-binding-20261113T093820Z-64900d.json)
passes 35 required steps, including the selected Python preparation, checkpoint
restart, sale/refund, application/controller/subs restore and later issuance.
Its 142 source hashes include `controller/native_binding.py`. Core and wallets
stay live during that restore. This closes the absence of current native
evidence for those scenarios only.

A separate [known-history host-recovery run](../regtest/runs/audit-root-binding-host-20261113T094308Z-7957b0.json)
passes all 43 required steps and binds 146 source hashes. It removes the
fixture seller's data, restores Core and Spaces wallets from onboarding
backups, restores journals and the coordinated subs snapshot, and completes
later issuance. The independent network, buyer wallets and relay survive.
It also attributes a payment made during host absence and refuses to invent
an unpaid historical invoice. This is a local regtest harness result, not a
signed-package or phone acceptance result.

Durable proof-submission ownership is still unfinished. The legacy `prove_push`
record does not prevent submission after an ambiguous prover response. Root
binding prevents use of another commitment's proving state, but does not
resolve duplicate prover work or charges.

The prior independent review receipt binds the final 54-file continuation at
`a2d0afb`. The accumulated PR changed 707 files against main at that point.
Neither the receipt nor this follow-up claims a fresh independent review of
the entire accumulated PR. Private receipts remain outside this repository.
