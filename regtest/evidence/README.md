# Kept certificate evidence

Label: regtest. These files come from kept runs on a local regtest network
(see `../REPORT.md`), one directory per run id. They are not mainnet,
integration or buyer-acceptance evidence.

Each run directory holds one subdirectory per certificate verification,
numbered in run order and named after its batch:
- `<handle>.message.bin`: the borsh-encoded message `subs` built for the
  handle, or, in a directory named `<batch>-relay`, the message the local
  relay answered to `/query` for the space and the handle;
- `anchors.json`: the root anchors read from `spaced` (`getrootanchors`) for
  that verification;
- `<handle>.libveritas.json`: what libveritas 0.4.4 returned then.

The handles are numbered test labels on the regtest spaces `@test10000` and
`@test9999`. Each full run's messages cover the first commitment (before and
after the lost-finality reorg), the second commitment with a step proof,
the third with a step and a fold, and the commitment adopted after a lost
broadcast answer. The `continued-u1b` run adds the fourth commitment of
`@test10000`, issued after the restore with the U1(b) patch. The
`publication` run adds the relay's answers: before publication (verified,
with no zone for the handle) and for the delivery lookup (the handle's
zone), for an initial commitment and for one with a step proof.
The `records` run adds scenario 9's signed records: in each
`-records-` directory, either a message the harness signed and sent to the
relay (with its `records.json`) or the relay's answer read back. Their
libveritas output also lists each zone's verified records.
The `recovery` runs (scenario 11) add the spaces `@test9998` and
`@test9997`. The lost host's runner verifications are under
`lost-host-runner/`, moved out of the host before it was deleted, and the
fresh host's under `runner/`, numbered from 001 again, because its
runner started with an empty directory. In
`recovery-20261110T050046Z-f7c0fa` and
`recovery-20261110T063824Z-59ce82`, `buyer-after-restore/` holds the
certificate the buyer downloaded from the restored host's order page,
built on a later root than its batch's.

To check them again offline, build the verifier once (`cargo build
--release` in `../verifier`) and run, from the repository root:

    regtest/verify-evidence.sh

It verifies every message against its anchors and checks that the zones
match the saved libveritas output, and the verified records too where the
run saved them. It needs no network and no running
stack.
