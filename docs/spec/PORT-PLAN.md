# TypeScript port and release handoff

Recorded at the workspace_owner's request on 2026-11-11. This is a proposed
implementation plan, not evidence that its deliverables exist. It does not
authorize deployment, wallet actions or opening sales. Payment behavior is
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
baseline; do not silently backport pilot features. The first such planned
fix is store process ownership. No amendment is implemented by this plan.

The public pilot uses the TypeScript store with the Python controller and
attended runner. Those components retain the applicable controller rules
and must pass the shipped combination's integration and recovery checks.
The end state removes the project's Python implementation and tooling;
temporary Python comparisons are not a permanent runtime dependency.

## Work order and gates

| Stage | Work | Evidence required before moving through its gate |
| --- | --- | --- |
| 1 | Extend case coverage and build the independent TypeScript pilot model. Land each new payment case with its passing model test. | Deterministic model tests, fixed spec traces and invariant checks. No production reducers inside the model. Coverage distinguishes baseline, model and production tests. Implement the release gate described below. |
| 2 | Finish the TypeScript store: domain changes, SQLite, journal, HTTP, registry callbacks, certificate views, restore and process ownership. | Named production tests, comparisons for unchanged baseline behavior, and service, checkout and recovery scenarios against the TypeScript runtime. Journal failure and interrupted-send tests preserve uncertainty. |
| 3 | Build the native installer, updater and Alchemy existing-host driver. Prepare the one-time import or compatible database reuse. | The same standalone package runs by hand and through Alchemy. Tests cover signature failures, resource deletion doing nothing to host data, host-key mismatch, competing writers, interrupted updates and reconciliation before readiness. |
| 4 | Rehearse installation and Python-to-TypeScript cutover on a disposable host using stage 3's package. | Existing payment addresses and their order attribution, issued handles, certificates, orders, refunds, uncertain attempts, identifiers and journal continuity survive. Host-loss recovery also works from the recovery set. No fresh-wallet shortcut forgets issued names. |
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

The current `tools/case_coverage.py --check` scans Python names and rejects
unknown IDs. Stage 1 extends that parser to literal TypeScript test names
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

Stage 1 must implement `python3 tools/case_coverage.py --release pilot`.
That option does not exist today and must not be used as release evidence.
It must reject unknown arguments, fail when any required pilot case lacks
a production test of its shipped component, and run as a required release
check with the relevant test suites. A TypeScript model test, a Python
store test or baseline-vector agreement cannot satisfy a TypeScript-store
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

## Pilot behavior and seller operations still to specify as cases

The payment-spec pilot decisions require cases for full-price late
reacquisition, pay-first admission and deterministic ties, the per-name
rolling hold ration, the global hold limit, the durable pause after ten
distinct conversions, buyer cancellation before issuance, the refund
deadline, estimated fees and the buyer/merchant fee split. Add the missing
refund-funding behavior as well. P12 already settles the lowered-price
outcome; its prose correction is not a new policy.

Use canonical `name@space` handles and an explicit space identity in the
TypeScript design. Avoid changing the running Python schema just to prepare
for multiple spaces. Backfill any new columns from validated handles at the
one-time cutover. Keep one issuance writer across the installation.

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
recorded per-space flags. These extensions need cases before they ship.

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

## Recovery work and scope limits

The installer must preserve state rather than empty the application after
an owner-only test. Prefer compatible database reuse if it is simpler than
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
