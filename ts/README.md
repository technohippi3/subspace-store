# TypeScript port (in progress)

The store is being ported to TypeScript. The domain code, Effect-based
storage and loopback buyer JSON API run in tests. The payment adapter now
has isolated Core 31.2 regtest qualification. Refund destinations,
durable reservations and explicit-input signed refund preparation now run
in tests (`../docs/spec/REFUND-PREPARATION.md`). First-attempt sends and
settlement/reorg accounting are now qualified in `../docs/spec/REFUND-SENDING.md`.
Family maxima, fee bumps and exclusive rebuilds now have separate coverage
in `../docs/spec/REFUND-FAMILIES.md`. Cancellation/refund-due clocks and
durable deficit/loss reporting are specified in `../docs/spec/REFUND-OBLIGATIONS.md`.
Read-only unsigned Core template measurement follows in `../docs/spec/REFUND-ESTIMATES.md`.
Converted/issuing excess clocks now use that assessment in `../docs/spec/EXCESS-DEADLINES.md`.
K21 keeps partial refunds cancel-first; a new purchase uses a new checkout.
The separate operator inspection listener is covered in `../docs/spec/OPERATOR-INSPECTION.md`.
Atomic issuing marks, live journal guards and frozen pending sets follow in
`../docs/spec/REGISTRY-ENTRY.md`. Entry retry, normal-process restart
and older-controller-database handling now follow `../docs/spec/ENTRY-RECOVERY.md`;
the HTTP controller protocol requires an exact entry/root/member binding.
Known-unsent bound-entry release/rebuild now follows `../docs/spec/ENTRY-RELEASE.md`.
Permanent closure cannot unlock a successor, and one-use broadcast permission
prevents a stale controller from releasing a possibly sent entry. Bound
commitment observations now track finality and reorgs (`../docs/spec/COMMITMENT-TRACKING.md`).
Bound certificate readiness, local cache and binary buyer download now follow
`../docs/spec/CERTIFICATES.md`. Verified-delivery callbacks and sticky
fulfilled recovery incidents now follow `../docs/spec/FULFILLMENT.md`.
One standalone JSON-API sale through the real Spaces stack and local relay
now passes with store crashes/restarts (`../docs/spec/RUNTIME.md`).
The same scenario now includes a real attended cancellation refund, with
the operator API/runner contract in `../docs/spec/ATTENDED-REFUNDS.md`.
Known-transaction confirmed delegate conflicts now have explicit supersession
and reorg-reversal handling (`../docs/spec/SUPERSESSION.md`). The store checks
the Core proof; Spaces root exclusion is a trusted controller attestation.
Browser checkout, remaining sale/refund scenarios, other supersession paths and full application
recovery remain. The Python service,
controller and runner remain the
complete implementation, and `docs/spec/` stays authoritative.

This port follows the workspace_owner's direction: TypeScript, Effect and
explicit state machines, deployed through Alchemy to a general Linux host
over SSH, not a provider's own service resource. The first pilot ships on
this store once it is complete, with the Python controller and attended
runner at first (workspace_owner, 2026-11-10; the pilot decisions at the
top of `docs/spec/PAYMENT-SPEC.md`). Complete means its database, journal
and HTTP API, built on Effect around these machines, and the regtest
service, checkout and recovery scenarios passing with it in place of the
Python store.

## Port handoff and pilot boundary

`../docs/spec/PORT-PLAN.md` defines the work order and release gates.
Stage 1 now has the independent model under `model/`, named model cases
K1–K20 in `test/model/pilot.test.ts`, generated trace/recovery checks and
coverage enforcement. `../docs/spec/PILOT-SPEC.md` states the exact scope
and expected outcomes. The Python store and model retain the owner-only
baseline at `66db98c`, plus the H12 process-ownership safety amendment.

The pilot model imports no production reducers. It models the new payment
admission, conversion-review, cancellation and refund-policy rules, with
explicit time and chain observations. It is not a full replacement for the
Python payment/controller model. These are model results only; real refund
funding, journal boundaries and node behavior need production/regtest tests.
Fixed traces and invariants supplement the model; baseline comparisons
remain for unchanged rules. The 2,000-step seeded trace caught and now
checks against a released hold reviving after a reorg (K19).

Case coverage accepts literal names such as
`test("K1: rolling ration", () => { ... })`. The directory distinguishes
model evidence from production tests in `test/production/`. The existing
unnumbered production-reducer tests remain useful but do not supply named
runtime coverage. The development gate accepts model evidence;
`python3 ../tools/case_coverage.py --release pilot` requires named production
coverage and currently fails. The pilot-readiness workflow runs both suites
and this release gate on manual dispatch or a `pilot-*` tag.

The native installer and updater precede the disposable-host cutover
rehearsal. Essential seller commands then precede the public-pilot gate:
setup, prices, reservation and withdrawal, global/per-space pause and
diagnostics. The pilot ships this store with the Python controller and
runner. Open catalog, bulk import and archiving follow the pilot; the
remaining controller, runner, model and tooling ports then remove Python.
The Python node/test-purchase track runs in parallel. Its store ownership
lock and real two-process H12 tests are now implemented locally.

## Current implementation

`node src/main.ts <config.json>` starts the regtest-only runtime. See
`../deploy/typescript-regtest.example.json` for its explicit configuration.
It requires existing fixture wallets, a dedicated journal directory and
private, distinct injected role-token files. New stores start paused.
Separate loopback ports serve buyer JSON, operator and subs pending routes.
The operator can journal listing-price and global-pause changes; this is
the narrow API for the harness and future seller CLI. Runtime polling
observes payments and advances existing deadlines through node outages;
it never broadcasts refunds. Live status supplies the shipped runner's
network/block checks. SIGINT/SIGTERM close the Effect scope and ownership.
This is a developer/regtest command, not the installer or update protocol.
Infisical retrieval and Alchemy integration remain planned installer work.

`src/refunds/` holds production fee policy, strict records and reservation
accounting, separately from `model/refunds.ts`. `src/bitcoin/refunds.ts`
builds and validates a first signed refund without broadcasting. The
application journals credit before signing, snapshots the buyer fee ceiling
at quote, excludes historical payment scripts from refund destinations and
retains signed attempts through restart. Order and merchant fee inputs and
change have explicit provenance. Installation requires explicit refund
policy and merchant fee-pool destinations; there are no deployment defaults
or automatic wallet-funding heuristics. These prototype application settings
must match their journal on restart; a future journaled operator command
will update policy for new quotes. No general migration layer was added.

The buyer JSON route accepts a refund destination, and views expose fee
ceilings, balances and sanitized group summaries. Preparation and sending
now have a strict operator HTTP/attended-runner boundary in
`../docs/spec/ATTENDED-REFUNDS.md`. Preparation retries recover the existing
outstanding group. TypeScript commands require explicit cause and reviewed
transaction/group confirmation; `refund-status` re-reads the current
receipt. No raw transaction is exported. Runtime polling never sends.
The first-attempt
sender journals uncertain intent before sending and checks live permission
immediately before the Core send RPC. Startup observes refunds before
returning a ready application; explicit reconciliation retries only absent,
previously attempted signed transactions. Reads never send. Settled charges
move from reserved to refunded, and losing settlement reopens the same
reservation. Admission subtracts only settled refunds. Conflicting spends
keep their reservations and a sticky rebuild guard, without an independent
replacement. Group and intent acknowledgments are reported separately.

All attempts remain journaled. A group's reservation is its historical
maximum, and settlement counts only the member that actually pays. Fee
bumps retain the parent's inputs; fresh families require a currently settled
conflict and exclusivity evidence against every older member. Core binds
ancestor bytes to transaction IDs before signing and broadcasting. Unknown
or mixed-ownership recovery funding pauses the obligation rather than
authorizing an independent payment. Only the latest previously attempted
member is retried per group. Views expose per-member positions, group
maximum and settled charges, without raw transactions or proofs.

The direct-ancestor funding planner is deliberately conservative. Full
recovery remains. Unconverted excess refunds and the
T3 skipped-script operator alert remain unsupported. Core qualification now
includes application sends, a lost reply and store restart, settlement
changes and deep reorg/re-mining, as well as proven change funding. These
use fresh isolated regtest wallets and do not pass public-pilot acceptance.

Three pure state machines and the store-wide request and quote rules were
ported from `service/ledger.py` as baseline-equivalence checks. The pilot
application's changed admission and hold rules live in `src/application/`.
The baseline reducers remain tested during the transition:

- `src/order.ts`, the order and name-hold machine of a fixed-price sale:
  hold, extension, conversion, late payment, quote, cancellation and the
  status moves the controller makes. Every status change is listed in
  `ORDER_EDGES`, and a name is free, held or reserved by type.
- `src/funds.ts`, an order's funds and refund obligations: the derived
  balances (`available`, `reserved`, `deficits`), refund groups closing,
  reopening and needing a rebuild, the `reconciling` reasons, the refund
  commands, and the refund destination, which is never a payment address
  of any order and is fixed once a refund is built. Whether another order
  holds a script for payment is the store's to say, with the event. A
  broadcast is a `send` effect for the store to carry out, and its answer
  comes back as an event.
- `src/incident.ts`, an order's recovery incident: opened or extended
  with an alert per new kind, closed only by a recorded resolution, and a
  new one after a resolution.
- `src/recipient.ts` and `src/admission.ts`, the rules that span orders,
  read from a store-wide view (`src/view.ts`): a request's canonical
  handle and P2TR key, script claims and conflicts, the start-up audit's
  flags and the conflict alerts, each raised once, a quote's guards in
  the service's order (asked again, recipient, taken, the sales pause,
  the exposure limit with its one alert, the journal), the exposure
  figure, and the search for a payment address that no order holds for
  payment or as its refund address. The search is a series of steps:
  each asks the store for another address from the wallet, an RPC the
  store makes outside its SQLite write transaction and under its
  serialized queue, and then judges the address it gets.

Each takes a state and one event, plus what the store observed where the
rules need it, and returns the next state or a refusal; the funds and
incident machines also return effects (alerts, authorizations, sends with
the exact transaction, rebroadcasts). None reads a clock, chain or
database or performs an effect.

## Durable runtime component

`src/storage/` now provides Effect-scoped SQLite persistence, a transactional
outbox, immutable journal objects, acknowledgment receipts, exclusive Linux
ownership and atomic/resumable journal-only restore. Production cases
Z1–Z9 and H12 exercise real SQLite, process death, Effect interruption,
journal outages, corruption and Python-created snapshots. The runner reads
this storage schema's acknowledged position for coordinated snapshots.
`../docs/spec/STORAGE-SPEC.md` defines the exact boundary and limitations.

The storage component's records are generic JSON. The application now adds
domain validation and quote/cancellation instruction gates. Real chain
observation and exclusive family sends are qualified. Cancellation clocks,
first-known broadcasts, permanent missed-target incidents, durable alerts
and recorded losses now persist through restart. Existing clocks can be
ticked during a Core outage through operator inspection and runtime polling,
without signing or sending. Converted/issuing excess clocks now admit
the inclusive estimated fee-plus-546 minimum and retain unknown-assessment
notices, earlier observation times and existing deadlines through failures.
Unconverted accounting and controller HTTP/whole-host
recovery remain.
Restored metadata requires reconciliation before the application can reopen
admission. The backend is an existing filesystem directory that must live
off-host for actual host-loss recovery; no object-store adapter is claimed.

## Not yet ported

Domain rules of `service/ledger.py` still to port, each with its home:

1. Complete browser order views and remaining Spaces-stack sales/refund scenarios.
2. Remaining registry recovery and alternative/unknown-transaction supersession.
   Pending selection, bound entry, commitment observation, certificate acceptance
   and explicit known-transaction delegate-conflict proof now exist. Generating
   a rollback, repairing the Spaces tree and resolving conflicts remain manual.
3. Restore from the journal (`restore_from_journal`), which always comes
   back with sales paused.

`src/application/` now has strict records, serialized Effect commands,
public request validation, journal-gated addresses/cancellations and
pilot hold/pay-first evaluation. `CHECKOUT-SPEC.md` defines the HTTP subset,
the real SQLite/HTTP tests with simulated node adapters and its limitations.
A 200-step application trace agrees with the independent pilot model on
the supported sales rules. K20 fixes the model's per-hold conversion
exemption; K4 also checks creation order independent of quote call order.
Full recovery remains unverified wherever only a restart was tested.

`src/bitcoin/` supplies loopback cookie-authenticated RPC, exact BTC parsing
and complete wallet receipt observations. `../docs/spec/CORE-SPEC.md`
defines readiness, stable-read guards and limitations. `npm run test:core`
qualifies real Core 31.2 in isolation, separately from the default test
suite's RPC stand-in. It retains artifacts under `regtest/.run/` and needs
the pinned binary from `../regtest/fetch-bitcoin.sh`, plus unshare and ip.
Hosted CI uses `test:core:ci` for privileged namespace creation followed by
an immediate drop to the original unprivileged UID/GID.
The application passes every historical payment destination to the adapter.
It also qualifies signing/sending, uncertain replies, store restart,
settlement/reorg accounting, proven change funding, fee bumps and direct
conflict-dependent families. Either an older or newer saved member may
win after a reorg; the ledger counts the group once.
Complete stack acceptance remains.

Unsigned Core template measurement now returns a coherent size/fee estimate
without signing, funding, locking inputs or allocating addresses. It can
measure spent wallet receipts but does not authorize spending them. Output
values are placeholders; only shape is measured. Actual refund signing
still measures and validates the final transaction.

The canonical excess estimate measures receipt metadata and P2TR change
shapes and allows one potential merchant fee input. It does not depend on
spendable fee coins or allocate addresses. Actual signing still enforces
funding, fee caps and the measured minimum. Unknown assessments are durable
operator notices rather than claims that excess is too small.

The first release closes an unconverted checkout before returning a partial
payment. Its old address and financial history stay with that refund-only
order. A new checkout has its own address; old payments cannot qualify it.
Continuing the same checkout after a partial withdrawal is deferred.

An authenticated operator inspection listener now exposes status, alerts,
order summaries and explicit observation on a separate loopback port.
Credentials are injected as an Effect and reevaluated without disk caching.
Atomic multi-member entry, fresh payment and recipient binding checks,
live per-order journal confirmation and frozen pending selection now use
the same application queue. The operator order-list HTTP shape contains
IDs as the Python runner expects; summaries remain on individual routes.
A separate subs credential/listener serves only the acknowledged pending
set. The actual Python runner/client and controller send gate are tested
over HTTP with a recording subs stand-in. No real commitment send is
claimed by that test. Eligibility proofs and quotas remain unimplemented.

The runner explicitly selects `store.implementation: "typescript"` for
the bound-entry protocol. Its entry ID is journaled before store contact.
Lost responses recover that same entry; attempted commitment sends remain
uncertain and are never repeated. An older controller database adopts its
newer journal identity, conservatively treating a newer issuing intent as
uncertain. The former anonymous issuing HTTP route is absent.

Safe bound-entry release/rebuild, commitment observation and certificate
acceptance now have their own protocol specifications. Certificate bytes
are reconstructible local cache; their binding and invalidation are journaled.
Bound delivery callbacks now retain first delivery and fulfilled ownership
across certificate loss, with explicit recovery incidents.
Next complete additional Spaces-stack qualification, remaining supersession/recovery, order views and
application recovery, then run the production gates above. The
controller port follows the first pilot and must preserve the specified
interrupted-broadcast recovery; the Python controller ships initially.

The runtime dependency is Effect 4.1.4. Development dependencies are
TypeScript 7.0.2 and full Node types, pinned in `package-lock.json`.
`.node-version` and CI pin Node 24.14.0; Linux util-linux `/usr/bin/flock`
is required. Node's SQLite API is marked active development, so runtime
upgrades need qualification through these tests. No native npm addon or
source build is required.

From this directory:

    npm ci --ignore-scripts
    npm run check
    npm test

CI runs the same (`.github/workflows/model.yml`, job `typescript`).
Production storage tests invoke Python only for temporary interoperability
checks with the controller and the baseline ownership lock; the storage
runtime itself never invokes Python.

## What the tests show

`transition` checks every order status change it makes: the edges it
reports must be listed in `ORDER_EDGES` and lead from the status before to
the status after. That table is derived from `MOVES`, so it can't catch a
wrong target declared there. Two independent sources do.

`test/order.test.ts`, `test/funds.test.ts`, `test/incident.test.ts` and
`test/admission.test.ts` have named scenarios for the rules, including a hand-written table of the
expected outcome of every order command from every status. The order tests
also run every event over a grid of states and observations (about
700,000 transitions), checking that the invariants hold after each, that
every listed edge is used, and that evaluation reaches a fixed point at
one observation.

`test/order-vectors.test.ts`, `test/funds-vectors.test.ts`,
`test/incident-vectors.test.ts` and `test/store-vectors.test.ts` run
`tools/ledger_vectors.py` and replay each transition it records through
the machine. The tool watches the Python ledger in directed runs (every
order command from every status; a few refund scenarios, such as a PSBT
export, a lost broadcast answer and the refund address; every incident
outcome; every outcome of a request and a quote) and on the model twin's
seeded sequences. The seeded sequences never reach incidents, the refund
address, the sales pause, the exposure limit or a refused recipient, so
those come from the directed runs alone.

For requests and quotes the replay compares the decision, the exposure
figure, every address the wallet gave out and the one chosen. It also
compares the start-up audit's judgement of each stored recipient, using
orders written into a stopped store's database as an older version could
have left them, each block check, and the orders the audit flags and the
conflict alerts it and every evaluation raise. For refunds
and incidents the effects are compared as well as the state:
alerts, authorizations, and every transaction the ledger handed to the
node, by group, inputs, outputs and signed bytes, against what the machine
says to send; and which attempts reconciliation would send again. A journal
entry acknowledging several groups is one event. The output fingerprints
the Python sources by SHA-256, with the git commit and the files changed
from it, and the tests print that.

Agreement is equivalence to the Python service, transition by transition.
It is not a model result and not regtest evidence, and it says nothing yet
about transactions, the journal, recovery or the commitment send.
`SUBSPACE_VECTOR_SEEDS` (default 8) and `SUBSPACE_VECTOR_STEPS` (default
150) lengthen the generated part, and `SUBSPACE_VECTOR_ROOT` points the
tool at another copy of the Python sources, for probes. One such probe:
both Python send paths changed to hand over different outputs and bytes
under the same txid fails the replay.

Mutations that fail the tests: `unready` targeting `converted`; a command
changing status while reporting no edge; the hold extension ending one
block early; the excess minimum off by one; a send without the journal
gate; reconciliation rebroadcasting an attempt never sent; a refund
destination that can change after a refund is built, or can be the
order's own or another order's payment address; an incident alerting
again for a kind already reported, extending a resolved incident instead of opening a new one, or
accepting an empty resolution; an off-curve key accepted; an uppercase
handle accepted; an unpaid quote claiming its script; a quote asked again
skipping the recipient checks; a partial payment counted twice in the
exposure; the limit alerting on every refusal; refund addresses not
skipped when choosing a payment address; the journal checked before the
pause and the limit; the audit judging nothing, missing the store's
payment scripts, or judging the key before the handle; conflicts not
blocking; one draw too many; skips miscounted; the audit clearing a
flag; a conflict alerted again; only converted orders alerted for a
conflict; the audit skipping the conflict alerts. One mutation survives and is equivalent:
reopening a refund group at exactly settled depth closes it again on the
same attempt in the same step.
