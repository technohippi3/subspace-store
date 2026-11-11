# Agent instructions

This repository holds the specification and the reference model of the
subspace store. Read `README.md` first.

## Scope and authority

The project is coordinated by a coordination-only task record in the
operator's private workspace register. That record lists what the
workspace_owner has authorized. Nothing in this repository authorizes more
than it does. In particular:
- no mainnet transaction, wallet action or funds movement without a concrete
  plan and the workspace_owner's explicit authorization;
- no production deployment, and no credentials in this repository;
- paid sales stay closed until the buyer gate and the operator gate in the
  specification both pass.

## Specification and model

- `docs/spec/` is authoritative. The Python owner-only test follows the
  behavioral baseline at `66db98c7bea395e7521039418d0ce6307ab67222`, as
  defined in `docs/spec/PORT-PLAN.md`. Do not silently backport public-pilot
  rules to it. Record any subsequent safety fix and its tests explicitly.
- Change a rule's specification and its governing model in the same commit.
  Python baseline changes use `model/`; new public-pilot rules use the
  independent TypeScript model planned under `ts/model/`. That model must
  exist before those rule changes land. Do not reuse production reducers
  inside it. A port-plan entry alone does not change either implementation.
  Runtime-only lifecycle rules, such as process ownership, land with their
  specification and integration tests; a simulated lock is not evidence
  that operating-system ownership works.
- Every new named case lands with its passing executable test. Python uses
  `test_<ID>_<description>`; TypeScript will use the literal name
  `test("<ID>: <description>", ...)` after the coverage checker supports it.
  `tools/case_coverage.py` currently scans Python only. Extend its existing
  unknown-ID rejection to TypeScript; do not add temporary case exemptions.
- Keep baseline, TypeScript model and TypeScript production coverage
  distinct. The planned `--release pilot` gate in `docs/spec/PORT-PLAN.md`
  must fail on missing production coverage before a public pilot release.
  It is not implemented yet; today's `--check` is not that release gate.
- A case without a test is a requirement, not a verified rule.
- Label model results as model results. Never report them as integration,
  regtest, mainnet or buyer-acceptance evidence.
- Keep the model deterministic: no wall clock, no unseeded randomness, and no
  network access.

## Checks

Before every commit, from the repository root:

    python3 -m unittest discover -s tests -t .
    python3 tools/case_coverage.py --check

and, for the TypeScript port in `ts/`, from that directory:

    npm ci --ignore-scripts
    npm run check
    npm test

CI runs both on every push and pull request (`.github/workflows/model.yml`).

Run tooling from this repository, never from the operator's staging
directory.

## Writing

Never write a personal name anywhere, including commit messages. Use role
identifiers such as `workspace_owner`, `operator` or `reviewer`. Write in
plain prose with short paragraphs. Never commit secrets, seed phrases,
private keys or `dev_private_key` values, even in test fixtures. Test keys
and transaction identifiers are made-up strings.

## Visibility

The repository is public on GitHub, as the workspace_owner authorized.
Everything committed is published, history included: before each push,
check the commits for private operational details, secrets and personal
names.
