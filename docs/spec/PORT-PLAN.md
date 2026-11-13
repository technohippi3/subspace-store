# TypeScript port and release handoff

Recorded at the workspace_owner's request on 2026-11-11; implementation
was then directed with “plan is clear? continue with pursuing it”. This
plan's implementation status is recorded separately from its requirements.
It does not authorize deployment, wallet actions or opening sales. Payment behavior is
owned by `PAYMENT-SPEC.md`; the deployment contract is in
`../../deploy/README.md`.

The target is one seller's installation, with TypeScript and Effect around
explicit domain state machines, a small seller CLI and Alchemy driving a
standalone installer over SSH. The first supported package uses native
Linux/systemd services. Bitcoin Core, spaced, subs and their cryptography
remain upstream native software. There is no multi-tenant platform or
general migration framework in this plan.

## Behavior during the transition

The Python store, Python reference model and owner-only test follow the
behavioral baseline at `66db98c7bea395e7521039418d0ce6307ab67222`, including
that revision's payment and owner-only-test specifications. An owner-only
test purchase means the operator acts as both seller and buyer; it is not a
privacy guarantee or a public sale. The baseline's positive-partial-payment
late reacquisition and owner-only cancellation remain its rules. Its tests
are valid baseline checks, not claims that the public-pilot rules work.

The new pilot rules govern the independent TypeScript model and TypeScript
store. Keep an explicit mapping when a pilot case supersedes a baseline
case, so both expectations retain a source. A safety fix to Python is
allowed and must record its spec, tests and commit as an amendment to the
baseline; do not silently backport pilot features. The first such
fix is store process ownership, now implemented and specified as H12 in
`PAYMENT-SPEC.md`, with real process tests in `tests/test_store_lock.py`.
The runner's live per-order journal readback before its send guard is a
further safety amendment, specified and exercised in `REGISTRY-ENTRY.md`.
It does not backport TypeScript pilot payment rules to the Python store.
`NETWORK-READINESS.md` adds the installation-wide lifetime fence to raw Python
and TypeScript entrypoints as another lifecycle-only safety amendment.

The public pilot uses the TypeScript store with the Python controller and
attended runner. Those components retain the applicable controller rules
and must pass the shipped combination's integration and recovery checks.
The end state removes the project's Python implementation and tooling;
temporary Python comparisons are not a permanent runtime dependency.

## Implementation status

The pilot production gate requires coverage for every applicable case. The
native package, generated host profile, Infisical retrieval, encrypted SSH
recovery and Alchemy existing-host driver
are implemented. The installed version 2 VM fixture exercises actual systemd
255, HTTPS, secret retrieval, update and service recovery using recorded
upstream RPC facts. The first profile is Ubuntu 24.04 x86_64. Development
candidates use test signing trust without production activation. Same-payload
real-native/browser receipts and the identified owner client/phone buyer gate
remain separate acceptance requirements. The paragraphs below describe
component evidence; they do not supersede the work-order gates.

The first implementation increment adds the TypeScript pilot model and
K1–K20 cases, a 2,000-step generated trace, development/release coverage
modes, a pilot-readiness workflow and the Python store ownership amendment
H12. Stage 2 now has the Effect storage component and production Z1–Z9/H12
tests for SQLite, journal acknowledgment, ownership and restore. It now
also has the buyer JSON API and domain persistence boundary described in
`CHECKOUT-SPEC.md`, tested with real SQLite/HTTP and simulated chain/wallet
adapters. A 200-step trace compares supported sales behavior with the
independent model. The payment adapter now also has isolated Core 31.2
regtest qualification (`CORE-SPEC.md`). Refund preparation now has durable
reservations and signed Core regtest evidence (`REFUND-PREPARATION.md`).
First-attempt sends and settlement/reorg reconciliation now have runtime
and Core evidence (`REFUND-SENDING.md`), followed by family maxima, fee
bumps and exclusive rebuilds (`REFUND-FAMILIES.md`). Cancellation/refund-due
clocks and durable deficit/loss reporting now have runtime coverage
(`REFUND-OBLIGATIONS.md`). Unsigned Core size/fee measurement is separately
qualified (`REFUND-ESTIMATES.md`). Converted/issuing excess assessment and
deadlines now connect them (`EXCESS-DEADLINES.md`). K21 keeps the first
release's partial refunds cancel-first; continuing an invoice after a
partial withdrawal is outside the pilot scope. Authenticated operator
inspection is qualified separately (`OPERATOR-INSPECTION.md`). Atomic issuing
marks, live journal confirmation and frozen pending sets now have separate
qualification (`REGISTRY-ENTRY.md`). Interrupted entry responses and
normal-process restart are qualified separately (`ENTRY-RECOVERY.md`).
Known-unsent release/rebuild and one-use broadcast permission now have
separate qualification (`ENTRY-RELEASE.md`). Commitment observations now track
finality and reorgs (`COMMITMENT-TRACKING.md`). Bound certificate readiness
and buyer download follow in `CERTIFICATES.md`. Bound delivery callbacks and
sticky fulfilled recovery incidents follow in `FULFILLMENT.md`. The standalone
process, sequential observation, injected credentials and live runner
network status follow in `RUNTIME.md`. One JSON-API sale through real Spaces,
subs, libveritas and the local relay now passes with store crashes/restarts.
The attended refund API/runner boundary now follows `ATTENDED-REFUNDS.md`,
with a real cancellation refund and exact transaction confirmation. Reads
and polling never broadcast; pending preparation retries reuse their group.
Known-transaction confirmed delegate-conflict proofs and their reversal now
follow `SUPERSESSION.md`. Real Core conflict/ancestry evidence is separate
from the trusted controller's Spaces root-exclusion attestation. Rollback
construction, tree repair and alternative/unknown-transaction paths remain.
Application journal replay and read-only inspection now follow
`APPLICATION-RESTORE.md`: restored invoices retain payment uncertainty,
certificates require re-verification, financial/issuance history survives
and quarantine is journaled. `RECONCILIATION.md` now defines offline
controller/subs reconciliation and journal-bound completion for known
histories, allowing only paused startup. The full-stack fixture restores
application/controller/subs paths and issues again while Core/wallets stay
live; that fixture does not qualify wallet or whole-host recovery.
`HOST-RECOVERY.md` extends the qualification procedure with fresh seller-node
and wallet paths from onboarding backups. Known mined history is its scope;
the complete multi-space in-flight recovery gate remains separate.
The TypeScript browser checkout now has production C1–C12 coverage through
the same commands as JSON (`CHECKOUT-SPEC.md`). Real-stack browser sale/refund
qualification against the final signed inventory and identified Nacho
buyer acceptance remain. Required sale/refund, supersession and recovery
cases now have shipped-component production coverage; this does not turn
recorded adapters into native-chain or deployed-stack acceptance. `NETWORK-READINESS.md` adds
explicit production network and durable payment wallet identity, authenticated
paused bootstrap and a separate TypeScript public pilot runner path. Its component tests do not establish mainnet transactions.
The source production-coverage gate now passes. Native export, scoped QR
capabilities and cold-start/maintenance lifecycle rules have model and production
coverage in `NATIVE-EXPORT.md` and `RUNTIME.md`. That source gate does not
establish the signed package, buyer-client or operator acceptance gates.
`RECOVERY-BACKEND.md` now defines the explicit version 2 remote journal
selection shared by startup, maintenance and host-loss recovery. Production
composition tests check complete decrypted prefixes, checkpoint acknowledgement
before restart, fresh snapshot materialization and matching parent/child
references. The installed version 2 VM fixture now exercises actual SSH, systemd and
restored-service ownership with recorded upstream RPC facts. The separate
real-native same-payload recovery and operator gate remain required.

The seller CLI and repeatable policy operations now follow
`SELLER-OPERATIONS.md`, including explicit request limits and funded owner
invoices. Cross-component production cases now execute the shipped Python
controller against the real TypeScript store. They close controller binding,
finality, cancellation, journal and deficit coverage with explicit pilot
applicability in `PILOT-SPEC.md`. They also expose and fix B5's durable
rebuild throttle and L8's missing-byte incident. Payment allocation now
records H11/T3's durable warning when the wallet repeats a retained
destination. Required restore cases now execute in production coverage.
Final signed-package/native acceptance and owner phone acceptance remain
open; passing source tests do not establish those gates.

The owned native exporter builder now runs in TypeScript with Effect at
`ts/tools/build-native-export.ts`. It retains the offline Rust build, path
remapping and artifact manifest contract, and pins the complete Cargo lock
digest. This removes that build tool's Python dependency; the controller,
runner, reference baseline and remaining tooling still require Python.

The bounded TypeScript/Effect controller kernel now handles a preexisting
checkpointed batch's bound entry, first-send arm, known-unsent close/rebuild,
durable rebuild throttle and normal-process restart, plus safe precommit
retirement without a preparation implementation.
It retains Python-shaped SQLite/JSONL history and the existing remote journal
protocol. `CONTROLLER-PORT.md` defines its scope and stand-in broadcast tests.
The shipped runner continues to select the Python controller. Batch preparation,
the remaining controller lifecycle, native adapters and full replacement
qualification still precede removal; this development slice changes no
pilot activation gate.

The 2026-11-13 runtime amendments repair two discovered gaps in both the
active Python controller and the TypeScript port. A failed parent is deduped
against all valid historical rebuild-guard rows, including after another
failure or reset. First retirement, rollback and parking require fresh known
non-issued statuses for every member, so forgetting an entry ID cannot erase
foreign armed ownership. `CONTROLLER-DESIGN.md` and `ENTRY-RELEASE.md` record
the contracts and focused tests. Prior journals and counts remain unchanged;
this is not a payment-policy backport or arbitrary-history cutover claim.

## Work order and gates

| Stage | Work | Evidence required before moving through its gate |
| --- | --- | --- |
| 1 | Extend case coverage and build the independent TypeScript pilot model. Land each new payment case with its passing model test. | Deterministic model tests, fixed spec traces and invariant checks. No production reducers inside the model. Coverage distinguishes baseline, model and production tests. Implement the release gate described below. |
| 2 | Finish the TypeScript store: domain changes, SQLite, journal, HTTP, registry callbacks, certificate views, restore and process ownership. | Named production tests, comparisons for unchanged baseline behavior, and service, checkout and recovery scenarios against the TypeScript runtime. Journal failure and interrupted-send tests preserve uncertainty. |
| 3 | Build the native installer, updater and Alchemy existing-host driver. Prepare import/reuse only if existing financial or issuance history requires it. | The same standalone package runs by hand and through Alchemy. Tests cover signature failures, resource deletion doing nothing to host data, host-key mismatch, competing writers, interrupted updates and reconciliation before readiness. |
| 4 | Rehearse fresh installation and recovery on a disposable host using stage 3's package; exercise history preservation if cutover actually has prior state. | Existing payment addresses and their order attribution, issued handles, certificates, orders, refunds, uncertain attempts, identifiers and journal continuity survive. Host-loss recovery also works from the recovery set. No fresh-wallet shortcut forgets issued names. |
| 5 | Deliver the pilot's seller CLI: guided setup, price changes, seller reservations and withdrawal, global and per-space pauses, status and recovery diagnostics. | Repeatable commands preview affected invoices and persist accepted changes. Named cases cover reservations, withdrawal/reopening, price changes and restore. A setup wizard calls these same commands rather than maintaining another configuration path. |
| Public-pilot gate | Release the TypeScript store with the Python controller and runner only after stages 1–5. | Production case coverage, the buyer and operator acceptance gates, complete sale and refund, deployed-stack recovery and explicit authorization to open sales. The review pause at ten conversions is implemented. |
| 6, after the pilot | Add open catalog, bulk import and space archiving; complete convenient onboarding of additional spaces. | Both catalog modes work per space. Searches create no orders; order creation is bounded separately from holds; issuance availability includes subs, chain and externally issued or in-flight names. |
| 7 | Port the remaining controller, runner, reference-model behavior and tooling, then remove Python. | The independent model, named cases, generated traces, regtest and recovery checks run without Python. The replacement controller demonstrates the same broadcast and recovery guarantees. |

The Python track runs alongside these stages. Check node readiness when it
is useful, without waiting for stage 4. Before an owner-only test purchase,
add the Python store's lifetime ownership lock and a two-process test. The
second process must refuse before database initialization, journal access
or startup reconciliation; the first releases ownership after a normal
exit, failed startup or process death. The lock file itself may be opened
to acquire ownership. A real purchase still needs its transaction plan and
authorization. Whether Python or TypeScript is ready first is assessed at
that time, not assumed from a short node-sync estimate.

## Case coverage and release enforcement

`tools/case_coverage.py --check` scans Python and TypeScript names and
rejects unknown IDs. The TypeScript convention is literal test names
of the form `test("P12: description", ...)`. It must retain unknown-ID
rejection and distinguish tests of the independent model from tests of the
production implementation. Test discovery alone does not prove a pass;
the corresponding suites must execute successfully in CI.

Each named case lands with a real passing test in the same commit. Payment
rule changes land with the independent TypeScript model and its test.
Lifecycle cases needing real processes, an installer or RPCs land with
their implementation and integration tests. Until then, the acceptance
tasks in this plan remain unverified work. Do not add skipped placeholders,
temporary exemptions or another case-status system to keep CI green.

`python3 tools/case_coverage.py --release pilot` is implemented and passes
on the current source. It rejects unknown arguments and
fails when any required pilot case lacks a production test of its shipped
component. It runs in the pilot-readiness workflow after the relevant test
suites. Future artifact publication must depend on this readiness result.
A TypeScript model test, a Python store test or baseline-vector agreement cannot satisfy a TypeScript-store
production requirement. Applicable Python controller/runner production
tests do count while those components ship. Explicit supersession mappings
identify replaced baseline cases; they do not excuse missing pilot rules.
Runtime boundaries need API/integration evidence in addition to pure
production-reducer tests. The development gate may pass on model coverage
while this release gate fails; paid sales stay closed in that state.

Keep Python vectors for unchanged behavior. New rules need both the
independent TypeScript model and reviewed fixed expectations derived from
the spec. Disagreements must be attributed to a specific rule change, not
hidden by disabling comparisons wholesale. Model agreement is supplemental
to cases, invariants, fault injection and regtest evidence.

## Pilot behavior and seller operations

`PILOT-SPEC.md` supplies K1–K20 with independent model tests for full-price late
reacquisition, pay-first admission and deterministic ties, the per-name
rolling hold ration, the global hold limit, the durable pause after ten
distinct conversions, buyer cancellation before issuance, the refund
deadline, estimated fees, buyer/merchant fee split and subsequent refund
funding policy. The shipped refund planner and wallet selection have
production and isolated Core regtest evidence; final same-payload acceptance
remains separate. P12 already settles the lowered-price outcome; its prose
correction is not a new policy.

Use canonical `name@space` handles and an explicit space identity in the
TypeScript design. Avoid changing the running Python schema just to prepare
for multiple spaces. Backfill any new columns from validated handles at the
one-time cutover. Keep one issuance writer across the installation.

`SELLER-OPERATIONS.md` now defines the implemented essential seller HTTP/CLI
operations and K22–K34, with an independent model and production tests. The
installer and deployed acceptance gates remain separate. First/later setup
uses the installed configuration without wallet reinitialization.

Seller reservations, buyer holds and fulfillment reservations are separate
concepts. Reserving or withdrawing a name blocks new invoices and reports
existing commitments; it does not silently revoke a valid hold or an issued
name. Specify that withdrawn names' expired invoices become refund-only,
and reopening does not revive them. An owner order may issue a reserved
name through the existing issuance rules. Catalog mode (explicitly listed
or open at a default price with exact-name overrides) is separate from
eligibility allowlists. Open catalog is an after-pilot feature.

The proposed multi-space scope is per-full-handle hold ration, global hold
and ten-conversion review limits, and one global exposure limit. Global
pause and per-space pause both block new admission; they do not cancel
existing commitments. Restore turns global pause on and preserves the
recorded per-space flags. K22–K34 govern these implemented extensions; production release still needs the
remaining acceptance and packaging gates.

The CLI's setup wizard uses the same validated operations as noninteractive
commands. Set up the first space without making configuration immutable:
later space onboarding, price changes, reservation changes and pause/resume
must not require reinstalling or repeating wallet setup. Use the same
operations for later spaces once multi-space acceptance is complete. Bulk
import and archiving do not block the essential individual-name operations.

Prices, the pilot risk budget, refund fee limits and the no-estimate fee
fallback remain operator decisions. The existing exposure formula remains
the smaller of ten times the highest listed price and the risk budget.
Replacing it with an explicit fixed budget independent of premium prices
is a proposal requiring a recorded policy decision, not an adopted change.

## Initial installation scope

Fresh installation into a new application data path is the initial
TypeScript release target. A general Python migration or live compatibility
layer is not a launch prerequisite. If an installation
has issued names, disclosed payment addresses or financial history, its
preflight must retain those obligations rather than treating it as empty.
External issuance state still needs reconciliation even with fresh wallets.
Future updates of a used TypeScript installation must preserve its data.

## Recovery work and scope limits

If an owner-only test or other activity creates history before cutover,
the installer must preserve that state rather than empty the application. Prefer compatible database reuse if it is simpler than
an import. The initial cutover is one explicit supported transition; future
releases need a versioned upgrade contract and a test from the previous
supported release. A database rollback cannot undo a broadcast.

`../../deploy/README.md` defines maintenance, Infisical outages, independent
backup-key custody and the Core 31.2 recovery tests, including node restart
while the store is down. Those cases must be specified and demonstrated
before relying on mempool timing to recover a hold. Neither a sales pause
nor six blocks guarantees a bounded drain. The one-minute replay and
four-hour host-recovery figures remain targets to demonstrate, not promises.

The initial host package targets an existing SSH-reachable Linux VPS.
Additional provider provisioning, Railway or container packaging is
qualified later. Coolify is not the wallet-host
deployment owner. Additional frameworks, dashboards, remote signers and
multiple recovery backends are not prerequisites for this port.
