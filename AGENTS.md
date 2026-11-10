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

- `docs/spec/` is authoritative. Change the specification and the model in
  the same commit when a rule changes.
- Every named case in a specification table gets a test called
  `test_<ID>_<description>`. `tools/case_coverage.py` reports the gaps.
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
