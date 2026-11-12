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
- `fetch-bitcoin.sh`: fetches only the checksum-pinned Core binaries. The
  TypeScript payment adapter's isolated `npm run test:core` uses them without
  building the complete issuance stack; `../docs/spec/CORE-SPEC.md` gives its scope.
- `in-netns.sh`: runs a command in the isolated namespace.
- `in-netns-ci.sh`: creates the hosted-CI test network namespace with sudo,
  then runs Node/Core as the original unprivileged UID/GID.
- `run-id.sh`: makes a fresh run id. Run ids are never reused, and the
  harness never deletes a run directory.
- `start.sh [prefix]`: starts a stack in the namespace and opens a shell
  there. Leaving the shell stops it. `stop.sh <run id>` stops a run's
  processes.
- `run-first-purchase.sh [prefix]`: the first purchase end to end on a
  fresh network, then stop. This is the milestone script.
- `run-typescript-sale.sh [prefix]`: a standalone TypeScript JSON-API sale
  through the shipped runner, real Spaces/libveritas and a local relay,
  including store crashes/restarts and application/controller/subs restore.
  It requires Node 24.14 or newer, pinned dependencies installed under `ts/`,
  the fetched stack, verifier and combined U1(b)/relay-seed subs build.
  Build them with `fetch.sh`, `build-combined.sh` and
  `cargo build --locked --release` from `verifier/` first. The scenario
  itself downloads nothing. It uses the bootstrap harness only to set up
  fresh chain fixtures; no purchase uses the Python registry. Its scope
  includes buyer cancellation and an attended runner refund received by
  the buyer, with exact transaction confirmation and restart checks. It
  restores fresh application/controller/subs paths and issues again, while
  Core and wallets stay live. It excludes browser checkout, buyer-client
  import and whole-host loss.
- `run-typescript-recovery.sh [prefix]`: the same actual TypeScript sale
  and attended refund with a separate surviving network node, buyer/miner
  wallets and relay. It replaces every seller data path, including Core
  and Spaces, restores the original onboarding wallets, then runs journal/
  subs/controller recovery and issues again. It tests payment during the
  outage, an unpaid historical invoice, credential rebinding and avoidance
  of historical address reuse. Build the same dependencies as the sale
  scenario first. Only known mined history is covered; this is not the
  full multi-space in-flight operator gate or packaged deployment.
- `run-all.sh [prefix]`: every numbered scenario in order. CPU proving makes it
  slow.
- `run-continued.sh [pinned|u1b]`: the first purchase, the second
  commitment and the restore, then another batch on the same space
  (scenario 5), with the pinned `subs` or with the U1(b) patch.
- `build-u1b.sh`: builds `subs` with `upstream/subs-u1b-attach-commit-txid.patch`
  as `.cache/bin/subs-u1b`, from a separate worktree of the pinned checkout.
  `SUBSPACE_SUBS_BIN` points a run at it, and the report records which
  `subs` ran.
- `upstream/`: the candidate upstream change U1(b) as a patch, with its
  draft submission (`U1B-SUBMISSION.md`), and
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
- `build-combined.sh` and `run-combined.sh [prefix]`: `subs` with both
  upstream patches (`.cache/bin/subs-combined`), and scenarios 1 to 6 in
  one run: recovery after a restore, continued issuance, publication and
  verified delivery.
- `build-private.sh`: the same pin with U1(b), explicit relay seeds and
  `upstream/subs-loopback.patch`, built as `.cache/bin/subs-private` in
  its own worktree. This build binds its API only to `127.0.0.1` (R7).
  The pinned and earlier patched binaries stay unchanged. The harness
  still runs in the isolated namespace, even with this build. It needs
  the dependencies fetched by `fetch.sh`; regtest publication also needs
  `certrelay` from `build-relay.sh`. See `upstream/LOOPBACK.md` for checks.
- `run-service.sh [prefix]`: the store service (`service/`) as its own
  process in place of the harness registry, killed and restarted along the
  way: a purchase through its API to verified delivery (scenario 7) and a
  cancellation refund with a real refund transaction (scenario 8). It uses
  the `subs-relay` build.
- `run-records.sh [prefix]`: the first purchase, then scenario 9: a handle
  sold to a script whose key the run holds, published and delivered
  through the local relay, and record sets for it signed, sent to the
  relay's `/message` and read back from its `/query`, each answer verified
  with libveritas against root anchors read from `spaced`. It uses the
  `subs-relay` build.
- `run-checkout.sh [prefix]`: scenario 10, the checkout pages and the
  attended runner: a buyer using only the pages, with a regtest wallet's
  script in the public request format, and every operator step after
  listing a name done by `python3 -m runner` as its own process, through
  issuance, certificate delivery to the order page, publication and a
  cancellation refund. It uses the `subs-relay` build.
- `run-recovery.sh [prefix]`: scenario 11, the operator gate's recovery
  rehearsal. A separate "network" bitcoind, with its own `spaced` and the
  relay, stands for the world. The host (its own bitcoind, synced from the
  network node as its one peer, `spaced`, `subs`, the prover, the store
  service and the runner) is lost whole with batches in flight on four
  spaces and a refund broadcast. A fresh host is brought up from the
  off-host recovery set alone: the journals, the latest coordinated
  snapshot, and the operator wallet's and the store wallet's backups taken
  at onboarding. It is reconciled through the runner's recovery commands,
  checked against the state before the loss, and issues again to
  fulfilled. It uses the `subs-combined` build.
- `keep-run.sh <run id>`: keeps a run's report and certificates in `runs/`
  and `evidence/`. It never replaces or removes anything already kept.
- `verify-evidence.sh`: verifies every kept certificate offline.
- `harness/`: the harness, standard-library Python.
  - `procs.py`: the processes and their ports.
  - `faultproxy.py`: a proxy in front of `spaced` and one in front of
    `subs`, each able to lose one response after the upstream call happened,
    or to withhold it, so that the caller waits until the host is lost.
  - `registry.py`: a minimal fixed-price registry, with the endpoints `subs`
    polls.
  - `controller.py`: the adapter that runs the controller of
    `controller/core.py`, the issuance cycle of `CONTROLLER-DESIGN.md`,
    against the stack: writes to `subs` through the fault proxy, the
    stack's control of the `subs` process, and the capabilities of the
    `subs` build the run uses.
  - `journal.py` and `rpc.py`: `controller/journal.py` and
    `controller/rpc.py` under their old names; on a run the off-host
    journals are a directory outside the host's state.
  - `oracle.py`: drives the reference model through the same events, so the
    report can set the model's expectation beside each regtest result.
  - `scenarios.py`: the scenarios, and `report.py` the report.
  - `publication.py`: scenario 6, the publication procedure of
    `CONTROLLER-DESIGN.md` (`controller/publication.py`) against the local
    relay, with delivery checked
    by verifying the relay's `/query` answer with libveritas against root
    anchors read from `spaced`.
  - `records.py`: scenario 9, signed records through the local relay.
  - `checkout.py`: scenario 10, the checkout pages and the runner.
  - `service.py`: scenarios 7 and 8, with `ServiceRegistry`, the
    registry's interface served by the real service over HTTP.
  - `recovery.py`: scenario 11, the recovery rehearsal, with the stack
    split into the world and the host.
- `verifier/`: a small Rust program that verifies a certificate message with
  `libveritas` 0.4.4, the version `subs` locks, against root anchors read
  from `spaced` directly. The same call verifies the message's signed
  records: it prints each zone's verified records and whether a set the
  message carried was dropped. `subspace-regtest-records`, in the same
  crate, makes a fresh regtest key and signs records for a handle, as a
  client publishing them would.
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
scenarios, not the product. Scenarios 7 and 8 replace the registry with the
store service; the controller is still the harness's. They cover the steps the scenarios take, and the
report lists what was not exercised. The pinned `subs`, built without its
`test-rig` feature, seeds the public relay network, which this harness must
not contact, so publication runs only with `subs-fabric-seed.patch` and one
local relay. Propagation between relays and buyer import are not exercised.
