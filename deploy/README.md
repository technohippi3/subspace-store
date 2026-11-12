# Native package and host examples

`NATIVE-PACKAGE.md` documents the implemented standalone native installer,
updater, Alchemy existing-host driver, scoped Infisical retrieval and encrypted
SSH recovery backend. Its first profile uses existing ready Core and spaced
wallets. The supported candidate profile is Ubuntu 24.04 x86_64/systemd 255.
The installed version 2 VM fixture exercises actual HTTPS, scoped secret retrieval,
encrypted SSH, update and service recovery with recorded upstream RPC facts.
Same-payload real-native/browser and owner-client acceptance require their
separate receipts. Candidate signatures are test-only; no production activation is
claimed. `OPERATIONS.md` gives the native operator commands.

The JSON files and user units below are legacy regtest examples with placeholder
paths. They are not generated installation profiles. The native profile
builder and installer are implemented under `native/`; use their generated
configuration for the installed candidate. No example authorizes a deployment.

- `store.example.json` configures the store service,
  `python3 -m service <config>`. Its keys are described in
  `service/__main__.py` and `docs/SERVICE.md`.
- `runner.example.json` configures the attended runner,
  `python3 -m runner <config> <command>`. Its keys are described in
  `controller/host.py`. `tests/test_controller_host.py` checks that it has
  every key the runner reads.
- `typescript-regtest.example.json` configures the standalone TypeScript
  regtest process, `node ts/src/main.ts <config>`. Its three listeners and
  explicit paths/policy follow `docs/spec/RUNTIME.md`. It starts paused and
  requires existing wallets, a dedicated journal directory and injected
  private role-token files. It does not install or deploy anything.
- `systemd/subspace-store.service` and `systemd/subs.service` are example
  systemd user units for the store service and for `subs`. `bitcoind` and
  `spaced` run under their own documentation.

None of them holds a credential. Bitcoin Core and `spaced` authenticate by
the cookie files they write at start-up. The Python store creates token
files with mode 0600 on first start; the TypeScript runtime requires
injected files and never generates or caches them. The configurations name
those files and never contain their contents.

The runner protocol is explicit. The Python owner-only baseline defaults
to `store.implementation: "python"`; the TypeScript pilot uses
`"typescript"`. Unknown values refuse before setup. There is no server
probe or failure fallback, and the TypeScript server rejects anonymous
issuing marks. `docs/spec/ENTRY-RECOVERY.md` defines its bound-entry
protocol, extended by `docs/spec/ENTRY-RELEASE.md` with permanent closure
and one-use broadcast permission. Server and controller must update together;
older pre-release receipt shapes fail closed. Known-unsent release is
resumable. Bound delivery has real local-stack evidence, and known-history
TypeScript host-loss fixtures exist. The final same-payload native recovery
and operator acceptance gate remains separate. These examples do not open sales.

`docs/spec/COMMITMENT-TRACKING.md` adds revisioned observations tied to
the exact armed entry and a matching Core tip. Receipt acknowledgment
means durable history, not current chain or certificate verification.
The TypeScript watch path must run with the updated store and driver.

Certificate bytes use `<database>.certificates/` as a private reconstructible
cache; metadata and invalidation are journaled. Configure the Core ancestry
adapter before accepting certificates. An existing cache is rechecked against
Core before readiness after restart. `docs/spec/CERTIFICATES.md` defines
redelivery after cache loss and the strict binary download gate. These are
component tests, not a deployed-stack recovery qualification.

`docs/spec/FULFILLMENT.md` adds verified-delivery callbacks and durable
recovery incidents. The publisher and server must update together; local
delivery completion follows the store acknowledgment. A recovery resolution
does not change balances or certificate validity. Full Spaces-stack and
whole-host recovery qualification remain separate from these component tests.

`docs/spec/ATTENDED-REFUNDS.md` adds the TypeScript refund operator API and
attended runner commands. Preparation requires `--cause buyer` or
`--cause merchant`; inspect the bounded receipt before broadcasting with
both `--txid` and `--confirm`. The same group is recovered after a lost
preparation reply. A changed transaction requires renewed review, and
runtime polling never signs or sends. The real regtest stack now qualifies
one cancellation refund into the buyer's wallet. The native installer now
implements maintenance and recovery coordination. Its recorded-RPC VM result
and the remaining actual native-stack recovery gate are distinct evidence.

`docs/spec/APPLICATION-RESTORE.md` defines the raw operator commands below.
Version 1 is regtest-only; version 2 requires the explicit installation network
and wallet binding in `docs/spec/NETWORK-READINESS.md`:
`node ts/src/main.ts restore <config>` replays a journal into a fresh database,
and `node ts/src/main.ts recover <config>` inspects fresh chain facts without
serving or sending. Stop and fence the old instance first. Exit 0 means its
receipt is acknowledged; it still reports controller reconciliation required.
Exit 2 means journal acknowledgment is pending. These commands preserve
quarantine and do not replace wallet backups, coordinated subs/controller
restore or the installed recovery choreography. `node ts/src/main.ts reconcile <config>
<runner-config>` now checks known bound history, restores controller/subs
when needed, and confirms both journals before paused startup. Unknown sends
and unsupported tree states retain quarantine. See
`docs/spec/RECONCILIATION.md` for its scope; Core and wallets remain live in
the current full-stack fixture. Never clear recovery flags by hand.
`docs/spec/HOST-RECOVERY.md` records the separate known-history whole-host
fixture. Restore original wallet backups and rescan before reconciliation.
After paused startup, configure subs with the replacement runtime's injected
registry credential and test its health connection before enabling admission.
An old snapshot's stored bearer token is not the replacement secret source.
Those earlier fixture receipts do not themselves qualify the native package's
separate Infisical retrieval and installer implementation.

Five of the requirements are not obvious from the files:
- The runner stops and starts `subs` around each coordinated snapshot,
  with the commands in `subs.stop_command` and `subs.start_command`. The
  stop command must return only once `subs` has exited; `systemctl stop`
  does. The controller then copies nothing unless a connection to `subs`
  is refused, and waits until it answers again before work resumes.
- `subs.capabilities.attach_txid` must say truthfully whether the `subs`
  binary has the U1(b) route of `regtest/upstream/`. The unmodified pinned
  upstream binary does not; the native package's reviewed combined build does.
  Without it, a later commitment restored without its `txid`
  blocks the next batch on that space, so the operator gate needs that
  capability or another reviewed recovery procedure
  (`docs/spec/CONTROLLER-DESIGN.md`, "What this requires").
- The `network` key is a claim the runner checks, not trusts. Before every
  command it asks `bitcoind`, `spaced`, the store and each `subs` endpoint
  (`url` and `write_url`, each for the `spaced` behind it) which network
  and chain they are on, by block hash, and runs nothing unless all agree
  with it.
- The journal and snapshot directories must be on storage that survives
  the host, which is what makes a journal-only restore possible.
- So must two backups taken at onboarding, which hold key material and
  are the operator's to protect: the operator wallet's export from
  `spaced` (`walletexport`) and the store's payment and refund wallet's
  backup from Bitcoin Core (`backupwallet`). The recovery rehearsal
  (scenario 11) restored a fresh host from those, the journals and the
  latest snapshot alone. Tokens and cookies aren't in that set: a fresh
  host makes new ones, and `subs` is given the store's new registry token.

The test operator's machine and its network confinement are described in
`docs/BUYER-GATE.md`, not here.

The unmodified pinned `subs` API binds to every IPv4 interface (R7), regardless
of configured loopback URLs. The native package requires the reviewed combined
build with loopback, U1(b) and explicit relay-seed patches, bound by its build
manifest. `regtest/build-private.sh` remains the older private-purchase recipe.
The installer preflight checks actual listeners; the legacy examples alone
provide neither that check nor host firewall setup. See
`docs/PRIVATE-PURCHASE.md`. Loopback binding adds no authentication for other
processes on the same host.

## Installation and updates contract

The contract below is part of `../docs/spec/PORT-PLAN.md`. Its native
implementation is under `native/`, `client/`, `recovery/` and `alchemy/`.
`../docs/spec/NATIVE-PACKAGE.md` maps the executable checks and their limits.
Existing examples above describe the Python baseline, including its locally
generated tokens; they are not an Infisical integration.

The first supported package uses native Linux/systemd services and stable
data paths separate from versioned release directories. It runs directly
on the host as a standalone installer/update artifact; Alchemy only drives
that same artifact. Application services use dedicated unprivileged users.
Keep Bitcoin Core, spaced and subs native and pinned. Installation checks
the actual host's systemd capabilities, storage, mounts and node readiness;
disk capacity and sync time are measured, not inferred from a provider name.

| Hosting path | Planned scope |
| --- | --- |
| An existing SSH-reachable Linux VPS | First package: native systemd and the standalone installer, with the same installation driven through a repository-local Alchemy resource. |
| Provider-created VPS through Alchemy | Optional provisioning that supplies a compatible host to the installer. Qualify the provider path separately; a provider resource is not proof the application can safely update there. |
| Railway, containers and Coolify | Later qualification. They must meet storage, resource, single-writer, snapshot and update requirements; they are not supported wallet-host deployment paths at the first pilot. Coolify may manage a separate storefront without privileged access to the wallet host. |

The Alchemy existing-host resource pins the SSH host key before its first
connection and reconciles the installed release and readiness idempotently.
Its delete handler does nothing to the host or its data, including when the
resource is removed from the program; test that behavior. Keep Alchemy
state, host addresses and operational configuration outside this public
repository and public outputs. Review their paths across Git history with
`git log --all -- <path>`, not just the current tree. State is not a wallet
backup or application journal. Moving a dashboard elsewhere does not remove
its privileged access to a wallet host.

Release artifacts carry a signed manifest of their digests and supported
schema/upgrade versions. The installer verifies the signature against a
previously trusted release key and checks the artifact digest before use.
It does not obtain its trust solely from the same unverified download. The
release signing secret is unavailable to the wallet host. Tests reject
modified artifacts, incorrect digests and untrusted signers.

An update first checks dependencies, credentials and recovery storage while
the old service still runs. It pauses new admission, inspects outstanding
holds and operations, and either proceeds safely or reports the specific
blockers. A pause alone does not drain holds: late invoices still receive
payments, six blocks have no fixed duration and a qualifying hold can last
longer. Do not promise a fifteen-minute or six-block update bound.

Maintenance must serialize every writer and send path. The store needs a
lifetime ownership lock acquired before database/journal initialization or
reconciliation. Stop new mutations and drain live calls, including direct
refund broadcasts; the controller lock alone does not cover them. The
updater must acquire the required ownership after old processes exit before
migrating or starting replacements. Two versions must never write together.
An interrupted broadcast remains uncertain until reconciled from evidence.

Take a coordinated checkpoint of the subs directory and both databases,
with journal positions. The maintenance owner also controls every restart
mechanism for subs: unit restart policy, timers, health automation and any
external supervisor. Subs must remain stopped throughout the copy, not
merely have accepted a stop request. A normal unit restart policy is not a
reason to omit this ownership check. Tests attempt a competing restart
during the snapshot and verify that it cannot invalidate the copy.

The replacement starts with admission closed and reconciles before it is
ready. Readiness includes store readiness and controller reconciliation;
an HTTP response or running PID is insufficient. Preserve the prior pause
state and the monotonic pilot review count. A failed update stays paused
with a useful diagnostic. An old release may be restarted only when its
schema is compatible. Restoring a checkpoint must reconcile later journal
and chain effects; it cannot undo a transaction already sent.

Use this package for the one-time Python-to-TypeScript rehearsal. Preserve
all historical payment addresses and their orders, names already issued,
certificates, obligations, uncertain sends and identifier/journal lineage.
Use compatible database reuse when simpler than importing. Fresh wallets
do not make names already in subs or on the chain available again. Future
releases test upgrade from the previous supported release; a general live
migration framework is not needed.

The store journal, controller journal and coordinated snapshots need one
supported off-host recovery backend. A second disk on the same VM is not
host-loss recovery. Quote addresses and final cancellations remain gated
by durable journal acknowledgment. An object-store implementation therefore
adds its latency and availability to checkout; during an outage, quoting
pauses. Do not describe this journal as an asynchronous export.

## Infisical and recovery credentials

The host retrieves runtime secrets with its own read-only Infisical machine
identity, limited to the installation, environment and required paths.
Use a service-specific retrieval user and restrict the bootstrap credential
to it through systemd credentials. Alchemy deploys references and retrieval
configuration; application and wallet secret values must not enter its
resource properties, state or outputs. Deployment credentials use a
separate identity. Verify the state/log boundary as part of packaging.
[Infisical Agent](https://infisical.com/docs/integrations/platforms/infisical-agent)
supports host retrieval; the
[Alchemy integration](https://alchemy.run/environments/infisical/)
loads secrets into the deployment stack, which is a different path.

Deliver fetched secrets as service-restricted runtime credential files,
not command-line values, release files or logged environment dumps. On a
VPS without a TPM, systemd credential encryption relies on a host key that
root can read. It protects against accidental exposure, such as a copied
encrypted credential without its host key; it does not protect the
bootstrap secret from someone who already has root. Root can also access
the running wallet. No stronger guarantee is implied by Infisical or
systemd credential encryption.
[Systemd credential documentation](https://systemd.io/CREDENTIALS/)
describes the service isolation and host-key/TPM options.

Infisical holds the operator and service bearer tokens, wallet passphrases
where used, backup encryption material and external service credentials.
Bitcoin Core and spaced cookies are generated locally at startup and stay
local. Wallet databases and application records remain protected persistent
data with encrypted backups, not values stored in a secrets service.

The first package has no automatic persistent cache of fetched runtime
secrets. The protected bootstrap credential necessarily persists; that is
not a cache of the secrets it can fetch. Running services retain the
credentials they loaded. A new start fetches the required values and fails
closed if it cannot. Rotation is deliberate and coordinated with services,
not an automatic restart that could interrupt a snapshot or hold.

If the host reboots while Infisical is down, the store stays down. Payments
can still arrive on the chain while it is unavailable. On recovery, keep
admission paused and reconcile affected orders and names before offering
them again. A missing observation does not establish that no payment was
sent or that it was late. The hold-recovery cases below are a pilot gate.

Keep an independently accessible offline copy of backup decryption material
and any required wallet passphrases, outside both the host and the
Infisical account. Do not encrypt that only copy with a key obtainable only
from the lost account. The attended recovery procedure supplies required
credentials through the same protected runtime mechanism, without fetching
from Infisical; it is an explicit recovery path, not a silent cache fallback.
It also documents access to recovery storage without the lost account;
having the decryption key alone is insufficient if the backups cannot be read.
Restore the registry token relationship consistently if service tokens are
replaced. Rehearse this path on a replacement host. The four-hour recovery
target is not established until that rehearsal passes.

## Hold-recovery requirements and evidence boundary

The separate TypeScript Core adapter qualification in `../regtest/REPORT.md`
now verifies ordinary mempool reload: entry time survives and entry height
is reconstructed at the reloaded tip. Its missing-mempool test explicitly
disables wallet rebroadcast, because a wallet can otherwise reannounce the
payment. That qualification does not adopt a hold-recovery rule or establish
the complete outage scenarios below.

Write named cases and executable tests before adopting mempool timing as a
hold-recovery rule. Bind evidence to the expected transaction outputs and
payment scripts. Test on the pinned Bitcoin Core 31.2 binary:

1. A payment reaches Core before hold expiry while the store is down, and
   remains in the mempool when the store returns. Compare its entry time
   and height with the intended hold rule; do not substitute restart time.
2. The payment confirms, is replaced, is evicted or disappears during the
   same outage. Missing mempool evidence must not invent an on-time or late
   observation or cause a second buyer to receive an already committed name.
3. Core also restarts while the store is down. Exercise normal mempool-file
   persistence and reload, and a crash or missing/stale mempool file. Test
   entry time and entry height separately, including expiry or failure to
   reaccept a saved transaction. Do not assume a preserved time proves a
   preserved entry height.
4. With a hold active, reboot the host while Infisical is unavailable and
   let a payment arrive during the outage. Exercise ordinary recovery when
   access returns and attended recovery from the independent material with
   Infisical still unavailable. Verify payment attribution, no duplicate
   issuance/refund, correct refund-fee responsibility and reconciliation
   before admission reopens.

Core 31.2's
[RPC source](https://github.com/bitcoin/bitcoin/blob/v31.2/src/rpc/mempool.cpp)
exposes local mempool entry time and height. Its
[persistence source](https://github.com/bitcoin/bitcoin/blob/v31.2/src/node/mempool_persist.cpp)
writes entry times and uses saved times when reaccepting transactions,
subject to load options and acceptance. That source reading is not the
recovery test. Once the transaction is absent from the mempool, this RPC
cannot supply its entry metadata. No automatic hold extension based on
inferred downtime is approved by this plan; ambiguous cases stay paused for
attended reconciliation, with store-caused refunds following the merchant
fee rule in the payment specification.


## Seller setup after host preparation

The host package first prepares the pinned node services, existing wallet
references, stable data paths and runtime credential injection. It supplies the
installed runtime configuration path to the seller command. Then use
`node ts/src/seller.ts <config> space add <space> --apply` for the first or any
later space and `admission set` for explicit installation request limits. The
command uses the authenticated running operator listener and never repeats
wallet initialization. Development fixture limits are durably marked as such
and cannot substitute for explicit funded-installation settings.

`docs/spec/SELLER-OPERATIONS.md` describes individual edits, review receipts,
funded owner invoices and private link files. Maintenance inspection is
`GET /operator/maintenance` as defined in `docs/spec/RUNTIME.md`; it does not
replace the updater's lifetime writer fence or coordinated checkpoint.


## Explicit TypeScript network configuration

`../docs/spec/NETWORK-READINESS.md` defines version 2 runtime configuration:
select `main` or `regtest` and supply `installation` with the expected genesis
and public descriptor fingerprint plus the package-created `maintenanceLock`.
The Python runner uses top-level version 2 and `maintenance_lock` for the same
protected ownership file. Both derive the durable sibling maintenance latch and
refuse normal starts while the updater owns maintenance. Version 1 remains regtest-only. Bind the
existing payment wallet before serving and preserve its installation identity
in the recovery journal. Public descriptors and credentials do not belong in
release state or public evidence.

For the TypeScript attended runner, select `store.implementation: "typescript"`
and exact `public_pilot` fields `version: 1`, `space` without `@`,
`minimum_fee_rate_sat_vb` and `maximum_fee_rate_sat_vb`. Runner network spelling
is `mainnet` or `regtest`. Public and private modes are separate. Every issue
requires an explicit rate within those bounds and exact attended confirmation.
Configure one space and acknowledge explicit admission limits through the
operator listener before public pilot readiness. The paused listener is
available for this setup; it is not permission to open sales.
