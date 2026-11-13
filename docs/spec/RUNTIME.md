# Standalone TypeScript process

`node ts/src/main.ts <config.json>` wires the existing Effect-scoped store,
Core payment/refund observers and three separate loopback HTTP listeners.
Version 1 accepts regtest only; explicit version 2 supports main and regtest
with the installation identity checks in `NETWORK-READINESS.md`. It neither installs the application nor
opens a production sale. No wallet is created, imported or unlocked. The
operator prepares existing fixture wallets and runtime credential files.

`APPLICATION-RESTORE.md` defines the separate `restore <config>` and
`recover <config>` commands. They print bounded receipts and exit without
listeners, signing or sending. A restored application remains quarantined
until the still-unbuilt controller-completion protocol succeeds; normal
startup cannot bypass that gate.

## Configuration and ownership

The version-1 configuration is exact: network, database, journalDirectory,
listen, core, credentials, riskBudgetSats, refundPolicy,
merchantDestinations and pollMilliseconds. The network must be regtest;
buyer, operator and subs ports are distinct, positive and at most 65535.
Every path is absolute. RPC is cookie-authenticated loopback HTTP with an
explicit wallet. The journal is an existing dedicated directory; none of
the other configured files belongs inside it. Risk budget, refund policy
and merchant destinations are explicit. Poll delay is 100–60000 ms.
Configuration contains credential paths, never token values. The process
does not infer a network or fall back to another implementation.

Credentials are nonempty printable bearer tokens of 32–256 characters in
regular files without group/other permissions. Operator and subs values
must differ. Both are reread for every authenticated request, including
after rotation. A missing, unreadable, permissive or malformed file, or
equal role values, withholds authentication with a generic unavailable
response. There is no token generation or persistent secret cache. These
files are the runtime injection boundary; Infisical retrieval remains
installer work. Locally generated Core/spaced cookies stay local.

The store takes its existing ownership lock before touching its ledger or
journal. Initial observation and existing certificate/refund reconciliation
must succeed before any listener or ready event is exposed. This is store
readiness, not controller reconciliation or whole-host readiness. If later
listener acquisition fails, acquired listeners and store ownership close.
SIGINT/SIGTERM interrupt the Effect scope, stop polling and in-flight RPCs,
close all listeners and release ownership. A crashed process releases its
OS lock. The CLI prints a generic failure without configuration or secret
values. The updater's hold draining and broadcast maintenance protocol are
separate unbuilt work; killing this process is not a routine update policy.

## Observation and operator boundary

One sequential observer sleeps between completed observations. It never
signs or broadcasts a refund and never retries an uncertain send. Node
failure retains the last persisted payment facts; it does not record an
empty chain or invent an on-time payment. Known deadlines still advance
through the node-independent tick. Later successful observation recovers
without a process restart. Operator status separately attempts live Core
readiness and exposes network, best_block_hash and blocks for the shipped
runner. Failure returns chain null; an old hash is not presented as current
network evidence. Existing status, alerts and deadlines remain inspectable.

New stores remain paused. Authenticated operator-only
`POST /operator/listings` accepts exactly handle and integer price_sats;
it uses the existing canonical-name and price rules. The reply includes
handle, price_sats and acknowledged. `POST /operator/pause` accepts exactly
boolean paused. Both commands require durable journal acknowledgment for
HTTP 200; an unacknowledged local change returns 503 and can be retried.
Neither allocates an address. Malformed, duplicate, escaped and unknown
members refuse before mutation. Listing updates affect the existing price
rules and do not rewrite quoted or converted prices. These narrow routes
support the regtest harness and future seller CLI. Reservations, withdrawal,
per-space pause and catalog modes remain separate planned work.

## Qualification

Production tests exercise the actual child-process entry point with a
recording Core RPC server, real SQLite, filesystem journals and OS ownership.
They qualify wiring, role isolation, credential rotation, polling, failure
cleanup and restart, not real Spaces proofs. `run-typescript-sale.sh`
separately drives fresh fixture wallets in a loopback-only namespace with
real Core 31.2, spaced, subs, libveritas and a local relay. That scenario
uses the buyer JSON API and shipped attended runner, and records exact
source hashes and crash/restart checks. `ATTENDED-REFUNDS.md` now extends
it through cancellation and a real attended refund received by the buyer.
`RECONCILIATION.md` extends it through application/controller/subs restore
and continued issuance using the existing combined U1(b)/relay-seed subs
build. Core and wallets stay live. It is not browser checkout, buyer-client
import or whole-host restore qualification.
Results are recorded in `regtest/REPORT.md`; the existence of the harness
alone establishes none of them. No deployment or sales-opening authority
is implied.

## Cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O55 | unsafe, unknown or incomplete runtime configuration | start | refuse before storage or RPC; only explicit regtest, paths, policy and distinct loopback ports accepted |
| O56 | separated runtime roles and injected credential files | request, rotate, equate or loosen file permissions | no cross-role routes/authentication; reread files and fail closed without caching |
| O57 | paid checkout and a later node outage | sequential background observation and recovery | conversion/settlement advance without buyer reads; failure retains facts; no signing or sending |
| O58 | configured runner inspects the store | Core is ready, changes network, loses wallet readiness or recovers | status uses live validated block/network facts; failures return chain null |
| O59 | listing and pause commands with malformed input or journal outage | send authenticated operator requests and retry | exact grammar; HTTP 200 only with acknowledgment, retry safe and no address allocation |
| O60 | one standalone CLI already owns the store, or later listener acquisition fails | start another process, terminate or fail startup | second owner refuses before RPC/journal mutation; errors scrubbed; scope closes listeners, polling and ownership |


## Maintenance inspection

Authenticated `GET /operator/maintenance` returns exactly paused, reviewCount,
blockers, ready, acknowledged and chain. Each blocker has kind and id. Chain is
null when current coherent observation is unavailable; otherwise it has height
and hash. The method serializes observation and journal checks under the store
queue. It performs no pause/drain mutation, signing, broadcast or refund retry.

Blocker kinds are admission_open, active_hold, issuing_order, armed_entry,
issuance_entry, uncertain_refund_send, restore_quarantine, chain_unavailable and
journal_unavailable. IDs are the relevant order, entry or transaction ID;
installation-level blockers use global. A recorded send lacking positive
mempool/mined observation blocks maintenance regardless of an older accepted
reply. A historical entry ceases to block when its commitment is final
and covered and every bound member has durable fulfillment with no open
recovery incident, or when the current observation positively revalidates its
active settled-conflict supersession proof. An immutable historical arm does
not permanently block that supported disposition; failed, unknown or reversed
proofs retain the blocker. Existing certificates and refund obligations remain stored.
A quarantined instance normally has no serving listener; an unavailable or
missing endpoint cannot authorize maintenance either.

Ready requires admission paused, fresh coherent chain observation, current
journal acknowledgment and no blockers. It is an inspection result, not a
lifetime maintenance lock. The updater must still fence every writer, controller,
refund send and subs restart mechanism before checkpointing or replacement.
Neither a pause nor fifteen minutes or six blocks proves a bounded drain.

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O97 | holds, armed entries, fulfilled final history, absent attempted refunds or chain/journal failure | authenticated maintenance inspection | report exact blockers and monotonic review count; exclude only resolved historical entries; no sends or pause mutation; ready only while paused with live acknowledged facts |

## Cold start and systemd credentials

Version 2 startup journals a global sales pause before observing invoices
or starting a listener. A disclosed invoice without persisted payment
detection becomes unknown; already detected history remains detected.
Grant times, conversion history, entries, certificates and recovery markers
are preserved. Startup requires live journal acknowledgment of the barrier.
It creates no full-host restore marker and infers no mempool timing or
extension. Explicit operator resume never turns unknown history back into a
payment request. Version 1 and direct application fixtures retain their
existing default; the internal startupPause option is always enabled by the
version 2 runtime and cannot be disabled in its JSON configuration.

Operator status reports unknown_payment_history as a nonnegative invoice
count. The updater leaves the new release paused for attended review when
this count is nonzero, even if admission was previously open. Closed unknown
history does not become a permanent maintenance blocker.

Ordinary injected credentials require a private, regular, singly linked
file, opened without following a symlink. Ubuntu 24/systemd 255 also supplies
root-owned 0440 files through per-service ACLs. Those permissions are accepted
only inside the exact canonical CREDENTIALS_DIRECTORY under /run/credentials,
with a root-owned 0550 directory and the exact read-only mount. An environment
variable or group-readable ordinary file alone cannot grant that exception.
The actual platform probe and application tests remain separate evidence.

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O151 | private ordinary credentials or root-owned systemd 255 credential files | read the configured role pair | ordinary group-readable, symlink and forged-directory inputs refuse; the exact protected read-only credential mount is accepted |
| O152 | previously disclosed invoices and a cold version 2 start | start with or without journal acknowledgment, then inspect or explicitly resume | durable pause and unknown-history prompt closure precede observation/listeners; original grants and detected/converted history remain; an unavailable acknowledgment prevents startup |

## Same-database maintenance reconciliation

The shipped maintain command takes a runtime configuration and controller
configuration after the updater releases exclusive installation ownership.
It acquires normal shared lifecycle ownership and exclusive database
ownership. It requires an initialized ordinary store and refuses actual
restore quarantine. It durably applies the same startup pause and unknown
history barrier before observations, then uses read-only wallet adapters.

A transient inventory binds the current checkpoint to the controller's
journaled proof. Independent chain, wallet, root and journal verification
runs before another coherent inventory and exact live prefix checks.
Completion returns an acknowledged paused receipt. It creates no persistent
host-loss marker, clears no real quarantine and does not invalidate a
certificate merely because maintenance happened. Real host loss continues
to use restore and reconcile. No maintenance path signs or sends.

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O153 | an initialized ordinary store or real restore quarantine | shipped maintain CLI and same-database reconciliation with valid, changed or unavailable proofs | pause/unknown barrier precedes observation; only coherent independently verified journal-bound completion is ready; actual restore stays quarantined and missing or uninitialized stores are not bootstrapped |


## Installed recovery ownership

The installed profile keeps a separate protected recovery.json beside the
maintenance lock while its fixed read-only recovery commands run under shared
ownership. Ordinary TypeScript startup, Python runner/controller construction
and the Python baseline service refuse this marker before storage, RPC or
listeners. A systemd mask alone is insufficient to exclude raw entrypoints.

Only the shipped TypeScript restore, recover, reconcile and maintain entrypoints
select the internal recovery purpose. The Python controller exception requires
the exact RecoveryStore read-only view; a config field, environment variable,
subclass or similarly named capability flag grants nothing. The marker must be
a bounded regular private single-link file owned by root or the current UID,
with version 1 and applicationPath exactly matching the running application
code root. The native profile creates it as root with mode 0600 and binds the
selected verified release's app directory. A different release, malformed,
unsafe or dangling marker refuses even read-only recovery. A maintenance latch
or exclusive owner still excludes all shared entrypoints.

The installer keeps ordinary services masked until independent reconciliation,
live journal proof and bounded ownership adoption finish. It then removes the
recovery marker before normal paused startup. A failure restores the marker,
maintenance latch and masks. Recovery grants no payment, signing or sending
capability and no automatic admission resume.

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O180 | a persistent installed recovery marker and released exclusive ownership | raw ordinary entrypoints or fixed read-only recovery commands compete | ordinary writers refuse before work; matching read-only commands retain shared exclusion and quarantine without sends; wrong code roots, fake flags and unsafe markers refuse |
