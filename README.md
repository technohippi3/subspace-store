# subspace-store

A self-hosted store for fixed-price names under a seller's top-level Spaces
name. Buyers submit a recipient request, pay on-chain Bitcoin and receive a
certificate for a name controlled by their own key. Checkout needs no account.

The first public pilot is one space with explicit listings, attended hot-wallet
refunds and a durable review pause after ten distinct conversions. Dutch
auctions, proof eligibility, open catalog, bulk import and space archiving are
deferred. The operator chooses prices, admission limits, fees and the risk
budget. The specification in [docs/spec/](docs/spec/) is authoritative.

## Current release candidate

The pilot store is TypeScript with Effect and explicit state machines. The
Python controller and attended runner ship with it during the transition;
the older Python store remains the owner-only behavioral baseline. The
[port plan](docs/spec/PORT-PLAN.md) records that boundary and the later removal
of Python.

The pilot production gate requires executable coverage for every applicable
case. Source tests cover the shipped store/controller combination, recovery,
seller operations, browser transport and native packaging. Isolated regtest
runs also exercise real Core, Spaces, subs, libveritas and a local relay; their
scope and limitations are in [regtest/REPORT.md](regtest/REPORT.md). Source
coverage and those historical runs do not establish final package acceptance.

The installed version 2 VM fixture exercises actual systemd 255, HTTPS,
Infisical retrieval, encrypted SSH, update and service recovery with recorded
upstream RPC facts. A candidate also requires separate real-native and browser
receipts against its exact signed payload. The candidate acceptance index binds
those results to its source and artifact hashes. Development candidate
signatures use disposable test keys. The supported host profile is Ubuntu 24.04 x86_64 with systemd 255; it requires existing ready
Core/spaced wallets and explicit prover and relay endpoints. See
[deploy/NATIVE-PACKAGE.md](deploy/NATIVE-PACKAGE.md) for the package boundary and
[deploy/OPERATIONS.md](deploy/OPERATIONS.md) for its commands.

Verified native SCRT and libveritas Message exports and certificate-only QR
links exist. The inspected Android Nacho 0.1.1 build 18 still uses a legacy
JSON manual-import path; its bundled native decoder is not connected to that
screen. Client import compatibility is a known blocker. Phone import, record
signing, transfer and independent recovery acceptance remain open.
The [device handoff](docs/NACHO-TEST.md), [buyer gate](docs/BUYER-GATE.md) and
[native export contract](docs/spec/NATIVE-EXPORT.md) describe the required
evidence. Browser QR checks are not phone import evidence.

Paid sales remain closed. Same-payload native/browser and buyer/operator
acceptance, explicit commercial settings and the workspace_owner's activation
authorization are required before opening the first pilot. This repository
authorizes no production deployment, mainnet transaction or wallet action.

## Code and entrypoints

[ts/src/](ts/src/) owns the pilot store: application records and serialized
commands, SQLite and acknowledged journals, Core observations/refunds, browser
checkout, seller operations and runtime ownership. `ts/src/main.ts` is the raw
runtime/maintenance entrypoint; `ts/src/seller.ts` uses the authenticated
operator API. Version 1 configuration is regtest-only. Version 2 binds an
explicit network and wallet identity and starts paused. Installed operators
use the generated configuration and native wrapper commands, rather than the
legacy example files.

[controller/](controller/) owns issuance intents, bound batches, broadcasts,
commitment/certificate verification and coordinated snapshots.
[runner/](runner/) is the attended command boundary over the TypeScript store
and native services. The runner selects `store.implementation: "typescript"`
explicitly; it does not fall back to the Python store. Runtime polling and
status reads never authorize an unattended refund send.

[deploy/](deploy/) owns signed assembly, installation/update/recovery, systemd
ownership, scoped secret retrieval, HTTPS, the encrypted recovery client and
restricted remote helper. Alchemy drives the same standalone installer over
pinned SSH. It does not provision a host or create wallets.
[native/export/](native/export/) builds the pinned native exporter;
[regtest/verifier/](regtest/verifier/) builds the libveritas verifier.

[ts/model/](ts/model/) is the independent pilot model.
[ts/test/production/](ts/test/production/) checks shipped components and their
boundaries. [model/](model/), [service/](service/) and [tests/](tests/) retain the
Python baseline and its recorded safety amendments; Python baseline tests do
not substitute for TypeScript store evidence. [regtest/](regtest/) contains the
pinned native harness, upstream patches and run reports.

## Development checks

Run tooling from this checkout. Use Node 24.14.0, Python 3.12 and Rust 1.94.1.
The default TypeScript suite also executes native-package fixtures: it needs
Linux `flock`, a working Docker daemon, QEMU, `genisoimage`, OpenSSH, `gpgv` and
the Ubuntu cloud image keyring. CI's exact prerequisites and pinned native
build preparation are in [.github/workflows/model.yml](.github/workflows/model.yml).
The guest and build inputs are fetched and verified during preparation.

From the repository root:

```sh
python3 -m unittest discover -s tests -t .
python3 tools/case_coverage.py --check
```

Then, from `ts/`:

```sh
npm ci --ignore-scripts
node tools/build-native-export.ts --fetch
npm run check
npm test
```

The exporter builder is TypeScript with Effect. It checks the complete pinned
Cargo lock before fetching, builds offline with remapped paths and records the
same native artifact manifest. From the repository root, after installing the
TypeScript dependencies, its direct command is
`node ts/tools/build-native-export.ts --fetch`.

`python3 tools/case_coverage.py --release pilot` is the production discovery
gate; the corresponding suites must execute successfully as well. The
[pilot readiness workflow](.github/workflows/pilot-release.yml) also runs the
isolated Core qualification. A model pass, named-test discovery or simulated
RPC result alone is not real-chain, installed-package or buyer acceptance.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
