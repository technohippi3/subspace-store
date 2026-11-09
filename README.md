# subspace-store

An open-source kit that anyone holding a top-level Spaces name can run to sell
names under it, with their own prices, eligibility rules, allowlists and Dutch
auctions. Buyers pay in on-chain Bitcoin and keep their names in their own
client. Nacho is the first client being tested.

"subspace-store" is a working title.

## Status

Pre-alpha. The MVP sells names at fixed prices. Dutch auctions are
specified but deferred until after the MVP. The first launch targets one
public space, fixed-price Bitcoin sales and Nacho as the first buyer
client, without ZK eligibility (workspace_owner, 2026-11-08); it doesn't
authorize mainnet transactions or opening sales.

There is a reviewed specification, a reference model of the fixed-price
rules, and a regtest harness that drives the pinned `subs`, `spaced` and
Bitcoin Core on a local regtest network. On regtest the harness has issued
names through to a certificate verified with libveritas and marked ready:
an initial commitment, later commitments with real proofs, a host restore
and a lost broadcast response. After a restore it issued another batch,
with a candidate upstream change to `subs` (U1(b)). It published
certificates to a relay running inside the test network and confirmed
each delivery with a verified lookup through that relay, so orders reached
"fulfilled". With the harness acting as the client, it signed records for a
delivered handle, sent them through that relay and verified them in the
relay's answers. A set signed with the wrong key was dropped.

That is regtest evidence, with two small patches to `subs` kept in
`regtest/upstream/`. It isn't a buyer's purchase. No buyer's client has
imported a certificate, nothing has touched the public relay network, and
the harness's registry and controller are test code.

The first milestone of the store service is in `service/`: durable orders,
quotes, recipient locking, holds and reservations, payment accounting,
cancellation and refund obligations, behind an HTTP API with no-account
checkout. On regtest, one purchase went through its API to verified
delivery while the service was killed and restarted four times, and a
cancellation refund was paid to the buyer by a real refund transaction.
`docs/SERVICE.md` records its choices and what it doesn't do yet.

The service can rebuild its own database from its off-host journal alone
after a host loss, shown over a simulated chain and beside the model, not
yet on regtest. It gives out a payment address, and reports a cancellation
final, only once its off-host journal has acknowledged the order, so a host
loss can't strand a payment or undo a cancellation it called final.

The buyer's checkout pages and the operator's attended runner exist too,
on regtest only. In run `checkout-20261109T141954Z-1d9c65` a buyer used
only the pages. The steps were: request, BIP21 invoice, payment, and a
certificate downloaded from the order page and verified with libveritas
(`regtest/REPORT.md` records all three checkout runs, the first a failure).
The runner carried the order through issuance and delivery. A second
order was cancelled and refunded through the same pages and runner. The
runner still drives the harness's controller through the harness stack,
so there is still no controller fit for a real host. There is also no
restore of the controller and `subs` together with the store, and no
installer. Nothing here is fit for selling
names, and paid sales stay closed until the buyer and operator acceptance
gates in the specification pass. The service runs on regtest only.
`regtest/REPORT.md` says what has and hasn't been exercised.

A passing model test shows that the specified rules are consistent on a
simulated chain. It is not evidence that real Bitcoin transactions, the
upstream Spaces software or buyers behave that way.

## Layout

- `docs/spec/`: the specification (`PAYMENT-SPEC.md`, `CONTROLLER-DESIGN.md`,
  `MODEL-PLAN.md`, `ELIGIBILITY.md`) and where it came from (`PROVENANCE.md`).
- `model/`: the reference model, in plain Python with no dependencies.
  `chain.py` simulates a Bitcoin chain with real spends, conflicts and
  reorgs. `store.py` holds the fixed-price payment, reservation and refund
  rules. `controller.py` simulates batch issuance: the binding check,
  `issuing`, uncertain broadcasts, supersession, finality and its loss, and
  the off-host journal. `sim.py` journals every call, and simulates outages
  of the two off-host journals, together or independently, and host loss.
- `service/`: the store service, standard-library Python and SQLite.
  `ledger.py` holds the fixed-price rules, written separately from the
  model; `bitcoin.py` reads Bitcoin Core and builds refunds; `app.py` is the
  HTTP API. Run it with `python3 -m service <config.json>` (regtest only).
- `tests/`: the named specification cases, one test per case identifier.
  Every fixed-price MVP case has one. There are also seeded generated
  sequences with invariant, replay and cut-and-resume checks, and the
  service run beside the model on those sequences (`test_service_twin.py`).
- `docs/BUYER-GATE.md`: the plan for the buyer acceptance gate with Nacho.
  `buyer-gate/operator.sh` runs its test operator: the pinned `spaced` and
  `subs` on mainnet in their own unprivileged namespaces, with outbound
  access only. It holds no credentials and signs nothing.
- `tools/case_coverage.py`: reports which named cases have tests.
  `tools/check_request.py` checks the format of a public recipient request,
  such as a Nacho export, as `POST /requests` does before reading any state.

## Running the checks

With Python 3.10 or later, from the repository root:

    python3 -m unittest discover -s tests -t .
    python3 tools/case_coverage.py --check

`SUBSPACE_MODEL_RUNS` and `SUBSPACE_MODEL_STEPS` lengthen the generated runs.

## Licence

Apache License 2.0. See `LICENSE`.
