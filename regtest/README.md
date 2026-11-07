# Regtest harness

This directory runs the subspace store's issuance path against the real
upstream software on a local regtest network: the pinned `subs`, `spaced`
v0.5.0 and Bitcoin Core. It is the smallest flow from a public recipient
request to an independently verified certificate, plus a second commitment
that needs a proof, a lost broadcast response and a host restore.

Results from here are labelled "regtest". They are not model results,
integration results, mainnet results or buyer-acceptance evidence, and the
report never calls them that.

## What it needs

Rust (stable), Python 3.10 or later, a C++ compiler for the RISC Zero
kernels, `unshare` and `ip` (util-linux and iproute2) with unprivileged user
namespaces enabled, and network access only while `fetch.sh` fetches the
pinned versions. It needs no credentials. Every run executes inside a new
unprivileged user and network namespace with loopback only (`in-netns.sh`),
so nothing outside the host can reach `subs`, which binds every interface,
and the stack can reach nothing outside. Setting that up changes no host
firewall, system or security setting. No mainnet, testnet or signet coins
are involved.

The space it operates (`@test10000`, and `@test9999` for the lost-broadcast
scenario), the operator wallet (`wallet_99`) and the funding wallet
(`default`) come from the preset regtest chain that ships in the spaces
repository's test utilities. They are upstream test fixtures, unpacked into
`.cache/` and never copied into this repository. The buyer, miner and store
wallets are made fresh for each run inside `.run/`.

## Files

- `pins.env`: the pinned upstream versions and the Bitcoin Core checksum.
- `fetch.sh`: clones and builds the pins into `.cache/` (not committed).
- `in-netns.sh`: runs a command in the isolated namespace.
- `run-id.sh`: makes a fresh run id. Run ids are never reused, and the
  harness never deletes a run directory.
- `start.sh [prefix]`: starts a stack in the namespace and opens a shell
  there. Leaving the shell stops it. `stop.sh <run id>` stops a run's
  processes.
- `run-first-purchase.sh [prefix]`: the first purchase end to end on a
  fresh network, then stop. This is the milestone script.
- `run-all.sh [prefix]`: every scenario in order. CPU proving makes it
  slow.
- `run-continued.sh [pinned|u1b]`: the first purchase, the second
  commitment and the restore, then another batch on the same space
  (scenario 5), with the pinned `subs` or with the U1(b) patch.
- `build-u1b.sh`: builds `subs` with `upstream/subs-u1b-attach-commit-txid.patch`
  as `.cache/bin/subs-u1b`, from a separate worktree of the pinned checkout.
  `SUBSPACE_SUBS_BIN` points a run at it, and the report records which
  `subs` ran.
- `upstream/`: the candidate upstream change U1(b) as a patch, and
  `subs-fabric-seed.patch`, which adds `--fabric-seed <url>` to `subs` so
  its fabric client uses the named relays instead of the public seeds
  (finding R19).
- `build-relay.sh`: builds `subs` with `subs-fabric-seed.patch` as
  `.cache/bin/subs-relay`, from a separate clone of the pinned checkout,
  and the pinned `certrelay` (the commit `subs` locks, in `pins.env`) as
  `.cache/bin/certrelay`.
- `run-publication.sh [prefix]`: the first purchase, then scenario 6:
  publication to a `certrelay` started inside the run's namespace, and
  delivery confirmed per handle by a verified lookup through it, so the
  orders reach "fulfilled". It runs with `SUBSPACE_RELAY=1`, which makes
  `procs.py` start the relay and pass `--fabric-seed` to `subs`.
- `keep-run.sh <run id>`: keeps a run's report and certificates in `runs/`
  and `evidence/`. It never replaces or removes anything already kept.
- `verify-evidence.sh`: verifies every kept certificate offline.
- `harness/`: the harness, standard-library Python.
  - `procs.py`: the processes and their ports.
  - `faultproxy.py`: a proxy in front of `spaced` and one in front of
    `subs`, each able to lose one response after the upstream call happened.
  - `registry.py`: a minimal fixed-price registry, with the endpoints `subs`
    polls.
  - `controller.py`: the issuance cycle of `CONTROLLER-DESIGN.md` against the
    real `subs` and `spaced`.
  - `journal.py`: the two off-host journals, simulated by a directory
    outside the host's state.
  - `oracle.py`: drives the reference model through the same events, so the
    report can set the model's expectation beside each regtest result.
  - `scenarios.py`: the scenarios, and `report.py` the report.
  - `publication.py`: scenario 6, the publication procedure of
    `CONTROLLER-DESIGN.md` against the local relay, with delivery checked
    by verifying the relay's `/query` answer with libveritas against root
    anchors read from `spaced`.
- `verifier/`: a small Rust program that verifies a certificate message with
  `libveritas` 0.4.4, the version `subs` locks, against root anchors read
  from `spaced` directly.
- `REPORT.md`: the report of the last committed run, labelled "regtest".

## Running

    regtest/run-first-purchase.sh

or, for everything:

    regtest/run-all.sh

Each run writes `.run/<run id>/report.md` and `report.json`. It keeps the
logs of every process under `logs/`, and every certificate verification
(message, anchors and libveritas output) under `certs/`.

Every step is "required" or "informational". The scripts exit 0 when every
required step agrees with the reference model, 1 when one disagrees, 2 on
an error, and 3 when the harness refuses to run, for example outside the
namespace or on a reused run id.

## Limits

The registry and controller here are harness code written for these
scenarios, not the product. They cover the steps the scenarios take, and the
report lists what was not exercised. The pinned `subs`, built without its
`test-rig` feature, seeds the public relay network, which this harness must
not contact, so publication runs only with `subs-fabric-seed.patch` and one
local relay. Propagation between relays and buyer import are not exercised.
