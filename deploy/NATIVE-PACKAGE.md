# Native package candidate

This directory contains the native package implementation and its qualification
fixtures. `OPERATIONS.md` gives the operator commands. Release signing and SSH
fixtures use disposable test keys; their signatures are qualification evidence.
The production trust key and activation remain operator-controlled inputs.

The first profile is `existing-native-linux-x86_64-systemd255`. Its qualified
platform is Ubuntu 24.04 amd64 with systemd 255, Python 3.12, OpenSSL 3 and the
bundled Node 24.14.0. The installer owns the store, subs and HTTPS system units.
Core 31.2, spaced, the explicit payment wallet and the explicit operator wallet
must already be ready and scanned. The profile also requires explicit prover
and relay endpoints. The complete payload contains their pinned native tools;
it does not create, import, unlock or fund wallets. Node indexing and storage
readiness are measured on the actual host before application maintenance.
The target host must supply `/usr/bin/python3` 3.12 and `/usr/bin/openssl`
major version 3 before running the installer or its signature and TLS checks.

`native/profile.py` generates the installation, runtime, runner, secret-source
and per-role recovery configurations from explicit inputs. It never chooses a
price, risk budget, fee range, wallet identity or admission limits. Initial
admission remains unconfigured. The operator can reach the paused store and
configure the seller through the existing authenticated CLI/API. A technical
installation receipt reports `waitingSellerSetup:true` and
`productionReady:false` until that setup qualifies. The actual public pilot
runner gate remains mandatory before sales or issuance.

`native/assemble.py` accepts a complete native artifact profile and reviewed
source. It copies all application Python and TypeScript source, installs the
locked production npm dependencies in the new payload, and copies the native
lifecycle, encrypted client and restricted remote helper. Its required binary
keys are node, bitcoind, bitcoin-cli, spaced, space-cli, subs, subs-prover,
certrelay, subspace-verifier and subspace-export. Rebuilt upstream artifacts
carry their shared source/lock/patch/toolchain manifest. The subs row must bind
the reviewed loopback, attach-txid and fabric-seed patches. The verifier and
exporter carry separate owned-build manifests. No record signer is packaged.

`native/release.py` builds deterministic archives and signs the exact manifest
bytes with Ed25519. The wallet host receives only a previously trusted public
key. It never learns a signing secret and does not acquire trust from the same
unverified download. The manifest binds the source commit, complete file and
archive digests, supported predecessor releases and explicit rollback targets.
The `schemas` values include RC compatibility epochs. They are not claims
about stored record version fields. Epoch 2 covers installation, seller and
capability application records and rebuild-guard/restore-provenance controller
semantics. An old implementation that ignores those meanings cannot appear
in a rollback whitelist, even if its SQLite DDL is unchanged.

`native/installer.py` is the one manual install/update entrypoint. The Alchemy
resource invokes that same entrypoint with the same manifest, signature and
archive. Bootstrap installer files and the trusted release public key are
provisioned through an independently reviewed path before the first SSH
installation; the downloaded release cannot replace that trust decision.

The installer serializes its own operations, checks dependencies and fresh
credentials while the prior service remains available, pauses admission,
reports live holds and operations, and requires the exact authenticated
maintenance receipt. There is no fixed drain duration. It writes a durable
maintenance latch, stops every managed writer, acquires the lifetime exclusive
fence, masks subs, and publishes an encrypted coordinated checkpoint covering
both databases, both acknowledged journal prefixes and the stopped subs tree.
It switches the complete release before releasing exclusive ownership. Normal
raw entrypoints then acquire shared lifetime ownership. No normal shared
owner is started while the updater holds exclusive ownership.

The replacement reconciles without listeners or wallet mutation capabilities,
then starts paused. The store and controller must independently prove current
chain/history facts and live remote durability. Unknown history prevents
automatic admission restoration. A changed conversion count also keeps it
paused. An unchanged reviewed count of ten or more preserves an explicit
earlier owner resume. A failed update leaves a durable fail-paused latch and
requires attended reconciliation or an explicitly compatible rollback.

Normal attended controller snapshots use `native/subs-fence.py`. The fixed
profile commands call it directly from the controller, without a sudo child.
It records the root controller module, current package directory, PID, UID,
boot identity and process-start fingerprint. A persistent subs latch and
runtime unit mask remain in force throughout copying and remote upload. The
raw subs wrapper also holds a data writer lock and checks the dedicated
lifetime fence. A dead owner is never replaced by a timeout. The explicit
recovery operation requires the installation identifier, a dead original
owner and an acknowledged paused store. Root remains trusted; arbitrary root
processes and unreviewed external supervisors are outside this contract.

The pinned subs configuration database is recognized before native exec. The
wrapper durably disables automatic registry publishing and installs the fresh
registry binding in its exact config table, preserving other settings. It
does not reinstall a wallet when a space is added. Unknown schema, links or
ownership fail before native startup. The per-start HTTP check only confirms
the already persisted binding.

## Credentials and public origin

Infisical Universal Auth executes on the host through `native/fetch-secrets.py`.
The identity is scoped to one project, environment and installation path with
read/readValue only; a project-wide Viewer grant is unnecessary. Its encrypted
bootstrap belongs to systemd, outside the release and Alchemy. Each service
start fetches fresh role files into `/run`; a failed fetch removes that role's
old output. There is no persistent fetched-value cache or implicit fallback.
Attended recovery requires explicitly selecting the attended source and
supplying protected temporary role files. No real credential is created here.

Core and spaced must create their original cookies privately on every start.
Retain `umask 077` in their launch environment, or `UMask=0077` in their
existing systemd units. The configured original cookie files must be current,
regular, single-link mode-0600 files, accessible to the root installer, with no
symlink at either configured file path. Verify replacement cookies after each
upstream restart before installation or recovery.

Core and spaced cookies enter service units through explicit external
LoadCredential references. Copies are per start. Native cookie rotation
therefore fails RPC checks until a controlled fresh store/subs start; it
does not trigger an automatic restart around holds or sends. Keep admission
paused, establish current node and wallet readiness, and follow the attended
recovery procedure in `OPERATIONS.md` to refresh those copies. Offline
maintenance obtains its own fresh role references and bounded cookie copies.
It never reads a stopped service's private credential mount.

Ordinary secret files remain mode 0600. The protected systemd 255 exception is
an exact canonical `/run/credentials/<unit>.service` directory with verified
root ownership, directory mode 0550, file mode 0440, no links, one file link
and a read-only mount. An environment variable alone grants no trust. The
actual bundled Node reader passed in a real LoadCredentialEncrypted unit in
the disposable KVM guest; the receipt contains only a boolean and digest.

The buyer listener remains loopback. `native/proxy.mjs` supplies the single
configured public HTTPS origin. It validates the certificate hostname, expiry
and key match. Local health connects to 127.0.0.1 with that hostname and CA
validation enabled. It rejects duplicate Host and HTTP framing ambiguity,
blocks operator/registry paths, strips forwarding headers and never chooses
an upstream from request headers. The trusted certificate-export origin must
exactly equal this configured origin. TLS keys and references stay outside
Alchemy state. The proxy has no URL or token access log.

## One remote recovery boundary

The only backend is a separately hosted POSIX directory behind a restricted,
pinned OpenSSH forced command. `recovery/helper.py` implements no shell,
overwrite or deletion. Its account owns only an installation-bound mode 0700
data root. Administrator-owned helper code and forced-command configuration
are separate from writable data. SSH forwarding, PTYs, password login and
agent access are disabled. Production storage must survive loss of the wallet
host; a second directory on that host is not qualified recovery storage.

The shared Node CLI encrypts before transport using AES-256-GCM with a
per-installation 32-byte key kept off the recovery server. Authenticated
contexts bind installation, stream, sequence, snapshot, path and chunk order.
Both application journals, coordinated snapshots and the original Core and
spaced wallet backups use this same backend. Public digests and opaque
snapshot names do not reveal plaintext payloads.

Immutable retries compare decrypted existing bytes before any new encryption.
Large journal records upload bounded encrypted chunks first and publish their
authenticated descriptor last. An interrupted chunk upload cannot advance the
head. Readback acknowledges only matching bytes after file and directory
fsync. Read, head and recovered descriptor operations repeat that durability
proof after a lost acknowledgment. Existing-file conflicts never overwrite.

The concrete limits are 1 MiB encrypted objects, 16 MiB plaintext journal
records, 8192 entries per journal page, 16 MiB decoded page bytes, 24 MiB local
CLI messages, 512 MiB total adapter replay, one million journal entries,
4096 files per snapshot, 15 GiB total plaintext, 16 GiB total snapshot ciphertext and a one-MiB authenticated descriptor. These are combined ceilings; a chunk list can reach the descriptor limit before the byte ceiling. Journal commands
have a 30 second transport deadline; snapshot commands have a 300 second
deadline. Large snapshots stream chunks. The profile refuses admission
capacity above the qualified 10,000 retained orders. Exceeding a transport
limit refuses acknowledgment and cannot authorize a send. Retention and
filesystem quota are explicit backend operator responsibilities; there is no
automatic deletion API.

TS v2 `recoveryBackend` and runner `recovery_backend` have the exact reference
shape `{version:1,node,client,config}` with absolute paths. The first profile
requires them. A present backend never falls back to a local mirror. Version
1 and direct legacy fixtures retain their unqualified file mode. Offline
store and runner views point at the same freshly generated maintenance
backend reference. Store receipts compare the full acknowledged outbox bytes;
controller receipts verify the decrypted prefix and exact copied batch
projection. Remote snapshot lists and fresh materialization remain authority
after host loss.

## Candidate acceptance evidence

The unconditional TypeScript production suite executes fresh release, helper,
OpenSSH, Alchemy and systemd fixtures. Its installed-host checks exercise actual
systemd 255, HTTPS, scoped secret retrieval, encrypted storage, writer exclusion,
update and rollback. Their upstream RPC facts are recorded. A passing platform
receipt does not establish a real financial-chain or buyer-client result.

Each complete candidate must retain an acceptance index bound to its source
commit, independently trusted manifest signature, archive hash and exact file
inventory. Keep the actual installed-application receipt, independent native
sale/refund and host-recovery receipts, browser screenshots and decoded QR
checks with that index. The local candidate/evidence directories are ignored
operator artifacts; this checkout contains no saved deploy/evidence receipts.
Source test discovery or an older candidate's receipt cannot satisfy a new
candidate's acceptance gate.

O149 executes a fresh representative 10,000-order production application restore
from encrypted OpenSSH into fresh SQLite, then measures a complete live-prefix
guard separately. Its generated validated history is not funded production
history. Retain its measured restore/guard timings and source hashes; the
under-one-minute recovery requirement does not establish request latency.

The same complete signed payload must pass installed version 2 bootstrap,
credentials, both journals, HTTPS, maintenance and service recovery, plus the
separate native-chain/browser scenarios. Nacho file/QR import, signed records,
transfer and independent client recovery require the identified owner build and
[device test](../docs/NACHO-TEST.md). Neither fixture RPCs nor native decoding
establish that phone acceptance or authorize production deployment.

## Official source evidence

The deployment driver pins
[2.0.0-beta.86](https://github.com/alchemy-run/alchemy/releases/tag/v2.0.0-beta.86),
with effect 4.1.4 and @effect/platform-node 4.1.4. The repository-local resource
uses the actual pinned [Provider API](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.86/packages/alchemy/src/Provider.ts)
and [Stack API](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.86/packages/alchemy/src/Stack.ts).
It persists only opaque configuration references, release identity and digest;
its delete handler performs no host mutation. Run its local state from a
private operator directory outside the public checkout.

Host retrieval follows the official [Universal Auth login](https://infisical.com/docs/api-reference/endpoints/universal-auth/login)
and the exact v4 secret response scope in the official
[OpenAPI description](https://app.infisical.com/api/docs/json).
The scope follows [machine identities](https://infisical.com/docs/documentation/platform/identities/machine-identities)
and [additional privileges](https://infisical.com/docs/documentation/platform/access-controls/additional-privileges).
Credential mount behavior follows the official
[systemd credentials contract](https://systemd.io/CREDENTIALS/).
