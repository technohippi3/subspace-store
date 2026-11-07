# subspace-store

An open-source kit that anyone holding a top-level Spaces name can run to sell
names under it, with their own prices, eligibility rules, allowlists and Dutch
auctions. Buyers pay in on-chain Bitcoin and keep their names in their own
client. Nacho is the first client being tested.

"subspace-store" is a working title.

## Status

Pre-alpha. The MVP sells names at fixed prices. Dutch auctions are
specified but deferred until after the MVP.

There is a reviewed specification, a reference model of the fixed-price
rules, and a regtest harness that drives the pinned `subs`, `spaced` and
Bitcoin Core on a local regtest network. On regtest the harness has issued
names through to a certificate verified with libveritas and marked ready:
an initial commitment, later commitments with real proofs, a host restore
and a lost broadcast response. That is regtest evidence. It isn't a
completed purchase: nothing has been published to relays or delivered to a
buyer's client, and the harness's registry and controller are test code.

There is no store, no persistent registry, no payment or refund service, no
real controller, no checkout and no installer. Nothing here is fit for
selling names, and paid sales stay closed until the buyer and operator
acceptance gates in the specification pass. `regtest/REPORT.md` says what
has and hasn't been exercised.

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
- `tests/`: the named specification cases, one test per case identifier.
  Every fixed-price MVP case has one. There are also seeded generated
  sequences with invariant, replay and cut-and-resume checks.
- `tools/case_coverage.py`: reports which named cases have tests.

## Running the checks

With Python 3.10 or later, from the repository root:

    python3 -m unittest discover -s tests -t .
    python3 tools/case_coverage.py --check

`SUBSPACE_MODEL_RUNS` and `SUBSPACE_MODEL_STEPS` lengthen the generated runs.

## Licence

Apache License 2.0. See `LICENSE`.
