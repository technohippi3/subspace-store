# Kept certificate evidence

Label: regtest. These files come from the passing run
`all-20261107T075846Z-ff80d4` (see `../REPORT.md`) on a local regtest
network. They are not mainnet, integration or buyer-acceptance evidence.

Each directory is one certificate verification, numbered in run order and
named after its batch:
- `<handle>.message.bin`: the borsh-encoded message `subs` built for the
  handle;
- `anchors.json`: the root anchors read from `spaced` (`getrootanchors`) for
  that verification;
- `<handle>.libveritas.json`: what libveritas 0.4.4 returned then.

The handles are numbered test labels on the regtest spaces `@test10000` and
`@test9999`. The six messages cover the first commitment (twice: before and
after the lost-finality reorg), the second commitment with a step proof,
the third with a step and a fold, and the commitment adopted after a lost
broadcast answer.

To check them again offline, build the verifier once (`cargo build
--release` in `../verifier`) and run, from the repository root:

    regtest/verify-evidence.sh

It verifies every message against its anchors and checks that the zones
match the saved libveritas output. It needs no network and no running
stack.
