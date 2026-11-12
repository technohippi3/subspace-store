# Installation network and payment wallet identity

The TypeScript runtime now has an explicit production network path. This is
source readiness, not permission to deploy, fund a wallet, send a mainnet
transaction or open paid sales. The Python owner-only store and its private
attended test remain at their frozen behavioral baseline.

Version 1 runtime configuration keeps its exact regtest-only grammar. Version 2
adds exactly `installation: {genesis, descriptorHash}` and `maintenanceLock`,
and accepts `main` or
`regtest`. The expected genesis must be the matching Bitcoin Core 31.2 genesis.
The wallet name remains explicit in `core.wallet`. Neither startup nor recovery
infers a network or creates/imports a wallet. The constants come from the
[pinned Core chain parameters](https://github.com/bitcoin/bitcoin/blob/v31.2/src/kernel/chainparams.cpp).

The public descriptor fingerprint is SHA-256 over compact UTF-8 JSON of the
sorted complete list of public descriptor expressions returned by
`listdescriptors(false)`. Empty or duplicate expressions refuse. The descriptor
checksum remains part of each expression. Mutable range bounds, timestamps,
next indices and reply order do not affect the fingerprint. A changed key set
requires an explicit future wallet transition; it is not adopted at startup.
Descriptors remain transient RPC input. Journal records and diagnostics contain
no descriptor, xpub, private key, cookie or bearer value.

After acquiring application ownership, startup observes pinned Core 31.2,
the configured network, synchronized headers/blocks, a loaded mempool, and the
named descriptor wallet with scanning false and its processed block at the
current tip. It reads block zero and the public descriptors and repeats
readiness at the same tip. It binds an acknowledged `installation_identity`
record with exactly version 1, network, genesis, wallet and descriptorHash
before listeners or the process-ready event. Version 2 must also match its
configured expectation. Version 1 startup must respect a saved identity too.
An existing unbound application projection may adopt only regtest; it cannot
be reinterpreted as a fresh main installation. All later guarded Core wallet
allocation, signing preparation and refund sends recheck the bound identity.
Failure grants no address allocation or send permission.

Journal-only restore preserves the identity and validates the configured
network before publication. Offline restore does not contact Core. Recover and
reconcile require fresh identity evidence and preserve quarantine on failure.
The child controller request carries the explicit parent Core network. The
runner uses `mainnet` for Core's `main`; both sides check that mapping. The
offline registry reports the bound parent network. Reconciliation compares
Spaces against `mainnet` or `regtest` accordingly, while retaining its current
tip, wallet, transaction, root, journal and no-send requirements.

# Lifetime installation maintenance fence

Version 2 requires an absolute `maintenanceLock` path. The package creates
`<baseDirectory>/lifecycle/maintenance.lock` as root:root mode 0644 with a
root-owned mode 0755 parent. Raw TypeScript serving, restore, recovery and
reconciliation acquire a shared flock before credentials, storage or journal
initialization and retain it for the complete Effect scope. Raw Python runner,
controller-host construction and the retained Python service/restore similarly
hold shared ownership through close. Python configuration version 2 requires
`maintenance_lock`; legacy configurations may opt in and otherwise retain their
regtest fixture behavior. This is a lifecycle safety amendment, not a backport
of public payment economics to the frozen Python baseline.

Both derive the durable latch as `maintenance.json` beside the configured lock.
A present latch, including a dangling symlink, refuses a normal start. Open the
existing lock without following symlinks or blocking on a special file. Refuse
nonregular files, multiple links, group/other writes, unexpected ownership,
inode replacement or exclusive-lock contention; recheck the latch around flock.
The package owns creation/removal of the protected latch. Runtime code never
creates or unlinks either ownership path. The updater uses exclusive ownership
after old processes close. Ordinary raw entrypoints have no environment or
configuration-omission bypass for a configured fence. The offline checkpoint
must run directly under its independently held exclusive owner and release it
before normal shared-lock reconciliation. The installer and complete update
rehearsal remain separate integration work.

# Authenticated bootstrap and public runner

A new store starts globally paused. Its operator listener remains usable for
authenticated seller preview/apply commands before admission limits are set.
This avoids a bootstrap cycle. A main installation cannot quote through either
buyer checkout or an operator owner invoice until explicit installation limits
are acknowledged. Resuming the global pause does not mark those limits set.
`production_ready` in operator status requires live validated chain evidence,
acknowledged application state, a bound identity and explicit limits on main.
The process-ready event reports the actual configured network; it means the
paused process is available for setup and inspection, not that sales may open.

The Python runner selects the TypeScript pilot explicitly with top-level
`public_pilot`, exactly `{version: 1, space, minimum_fee_rate_sat_vb,
maximum_fee_rate_sat_vb}`. Space is the canonical label without `@`. Rates are
integers with `1 <= minimum <= maximum <= 100000`. Network is explicitly
`mainnet` or `regtest`, `store.implementation` is `typescript`, and
`private_attended_test` is absent. This is separate from the private allowance;
the private Y cases and Python store economics are unchanged.

Before public pilot work, require the store's bound network/genesis/descriptor
identity, explicit limits, exactly the configured space and production
readiness. Independently require ready Core 31.2, the expected genesis, a loaded
mempool and a synced txindex at the current height. Core, store, spaced and both
subs endpoints must share the same tip, and the operator wallet must be scanned
to it. Repeat the Core and spaced tip after inspection. Admission remains
paused whenever the surrounding release/operator gates require it.

Issue requires an explicit fee rate within the configured range and the exact
batch confirmation. Resume and rebroadcast recheck the persisted rate. A batch
from another space refuses. Refund broadcasts retain the exact group and
transaction confirmation and the store's existing journal/send guards. No
public mainnet path defaults the issuance rate to 1. Recovery-only construction
requires the offline registry and disables normal preparation, signing and
send methods; it does not need public sales admission configuration.

# Cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O120 | version 1 or version 2 runtime input | validate supported and malformed network/genesis/fingerprint fields | preserve regtest-only version 1 and require exact explicit version 2 identity before storage/RPC |
| O121 | acknowledged bound installation | replace payment descriptors and restart | refuse before listeners, journal mutation or wallet action |
| O122 | fresh main installation without explicit limits | use authenticated seller setup, resume, buyer quote and owner invoice | bootstrap works; all invoices and production readiness wait for acknowledged explicit limits |
| O123 | a bound main journal | restore with matching or version 1 configuration | preserve identity and quarantine; refuse network relabeling without a wallet action |
| O124 | a live bound Core adapter | substitute descriptors before wallet allocation or refund send | refuse before wallet mutation, permission or send |
| O125 | a previously used unbound regtest projection | start version 2 main | refuse before Core observation or listeners; do not adopt legacy history as fresh |
| O126 | shared runtime owners | an updater requests exclusive ownership before and after they close | real Linux flock survives helper exit and excludes the updater until the final close |
| O127 | updater exclusive ownership | raw TypeScript serving/recovery or Python runner/controller/store/restore starts | refuse before RPC, database, journal or credentials work |
| O128 | persistent or dangling latch, writable lock or symlink | acquire through either raw helper | refuse without waiting, unlinking or mutating ownership paths |
| A58 | runner configuration | select public, private, Python or malformed pilot configuration | only explicit separate TypeScript pilot is admitted before files/RPC |
| A59 | public pilot peers | vary index, wallet readiness, identity, limits, spaces or any peer tip | fresh coherent evidence required; every mismatch withholds sends |
| A60 | public issuance or refund attempt | omit/change fee rates or exact confirmations, or use another space | guard every supported issue/resume/rebroadcast/refund path without an implicit rate |
| A61 | parent-bound offline recovery | mismatch the runner network or call a normal send method | refuse mismatches before construction and expose no normal send capability |

The component tests use recording peers and real HTTP, SQLite, ownership and
journals. The Core qualification separately reads actual public descriptors,
advances the keypool and checks stable identity plus refusal of another
fingerprint on isolated Core 31.2 regtest. Neither establishes mainnet payment,
Spaces sale, whole-host recovery or buyer-client acceptance.
