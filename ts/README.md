# TypeScript port (in progress)

The start of a port of the store to TypeScript. Nothing runs from it yet:
the Python service, controller and runner in the parent directory are the
implementation, and `docs/spec/` stays authoritative.

Three pure state machines and the store-wide request and quote rules are
ported so far, from `service/ledger.py`:

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

## Not yet ported

Domain rules of `service/ledger.py` still to port, each with its home:

1. What the buyer is shown: an address and a cancellation only once the
   journal acknowledged them (`instructions_given`, `order_view`), and a
   certificate only for a ready or fulfilled order (`deliver_certificate`).
2. The registry callbacks (`pending_for`, `subs_ack`, `subs_committed`).
3. Restore from the journal (`restore_from_journal`), which always comes
   back with sales paused.

Then the store layer around the machines (SQLite transactions, the
journal, the HTTP API), and the controller, whose batch machine needs the
interrupted-broadcast recovery decided in the specification first.

It has no runtime dependencies. Its only development dependency is the
compiler, pinned to TypeScript 7.0.2 (the native compiler) in
`package-lock.json`. Node 24 runs the TypeScript directly:

    cd ts
    npm ci --ignore-scripts
    npm run check
    npm test

CI runs the same (`.github/workflows/model.yml`, job `typescript`).
`test/node.d.ts` declares the few Node APIs the tests use, until the
package takes `@types/node`.

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
