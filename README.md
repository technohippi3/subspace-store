# subspace-store

An open-source kit that anyone holding a top-level Spaces name can run to sell
names under it, with their own prices, eligibility rules, allowlists and Dutch
auctions. Buyers pay in on-chain Bitcoin and keep their names in their own
client. Nacho is the first client being tested.

"subspace-store" is a working title.

## Status

Pre-alpha. There is a reviewed specification and a reference model of its
payment rules, and nothing else. There is no store, no registry, no
controller and no installer. Nothing here is fit for selling names, and paid
sales stay closed until the acceptance gates in the specification pass.

A passing model test shows that the specified rules are consistent on a
simulated chain. It is not evidence that real Bitcoin transactions, the
upstream Spaces software or buyers behave that way.

## Layout

- `docs/spec/`: the specification (`PAYMENT-SPEC.md`, `CONTROLLER-DESIGN.md`,
  `MODEL-PLAN.md`, `ELIGIBILITY.md`) and where it came from (`PROVENANCE.md`).
- `model/`: the reference model, in plain Python with no dependencies.
  `chain.py` simulates a Bitcoin chain with real spends, conflicts and
  reorgs. `store.py` holds the fixed-price payment, reservation and refund
  rules. `sim.py` journals every call so a run can be replayed.
- `tests/`: the named specification cases, one test per case identifier,
  plus seeded generated sequences with invariant, replay and cut-and-resume
  checks.
- `tools/case_coverage.py`: reports which named cases have tests.

## Running the checks

With Python 3.10 or later, from the repository root:

    python3 -m unittest discover -s tests -t .
    python3 tools/case_coverage.py

`SUBSPACE_MODEL_RUNS` and `SUBSPACE_MODEL_STEPS` lengthen the generated runs.

## Licence

Apache License 2.0. See `LICENSE`.
