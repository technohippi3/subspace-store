# TypeScript known-history host recovery

This is the qualification procedure for `APPLICATION-RESTORE.md` and
`RECONCILIATION.md` after replacing the seller host, including its Core and
Spaces wallets. It adds no permission to send an uncertain transaction and
does not change the frozen Python store's behavior. The test is isolated
regtest using fresh fixture wallets. It is not a production installer.

## Recovery inputs and order

The off-host recovery set contains both append-only journals, the latest
coordinated subs/database snapshot, non-secret financial/runtime
configuration, the original Core payment-wallet onboarding backup and the
Spaces operator-wallet onboarding export. Wallet backups hold key material;
keep them encrypted off-host in deployment, with independent access to their
decryption key as `deploy/README.md` requires. They are never public evidence
or values to put in Alchemy state. Infisical runtime integration is still
planned; locally generated fixture credentials do not qualify it.

Fence the old host. Bring up fresh Core and Spaces data directories against
the surviving network, restore/import the original wallets, and wait for
both scans and transaction history to reach the same active tip. Fresh
wallets cannot replace those backups: they would forget old addresses,
funds and issuance dependencies. Missing ownership or history must refuse
recovery rather than imply zero payments. A wallet restoring successfully
does not establish application readiness.

Run the shipped restore command into a fresh application database using the
original journal and financial configuration. Run reconcile with the
replacement host's runtime/runner configuration. It restores subs and the
controller as necessary and applies the existing two-journal completion
protocol. A fresh Spaces instance may reach its tip before creating its
root-anchor file. Retry only the known anchor-file open/read errors with
the existing finite attempt limit; all other errors refuse immediately.
Exhaustion retains quarantine and requires another attended attempt.

Start the application paused. Configure subs' registry endpoint and bearer
credential using the replacement runtime's injected secret, with automatic
registry synchronization disabled. A restored subs snapshot may contain
an older credential. Before enabling admission, use subs' existing
`/config/test/registry` route to check its stored credential against the
paused store's health route. This is an explicit attended configuration
step; reconcile does not rotate credentials or fetch Infisical secrets.
The eventual installer must perform it before declaring the installation
ready. A failed probe leaves admission paused. Never print the credential
or include it in the recovery receipt or evidence.

Fresh Core observations attribute payments received during the outage to
their original immutable invoices. No observed-on-time timestamp is
invented. An invoice still unseen after rescan remains unknown and its
buyer view withholds another payment request. The first new quote must
skip every address already held in the recovered application history,
including unpaid, cancelled and fulfilled invoices, even when an old
wallet backup's address cursor has moved backwards.

Fulfillment's first receipt/reserve and settled refunds survive. Certificate
cache is absent; fresh chain checks and real verification must rebuild it.
Re-enabling admission is a separate explicit operator action. Continued
issuance still uses fresh bound entries and attended send confirmations.

## Test scope

`regtest/run-typescript-recovery.sh` reuses the existing separate-network
recovery fixture. The network node, its buyer/miner wallets, world Spaces
instance and local relay survive. Every seller process is killed and all
seller data paths, including node data and both runtime credentials, are
moved out of the replacement paths and kept for failure analysis. The
replacement does not read them. It uses only the declared recovery set,
source package and independently supplied replacement credentials.

The scenario starts with a fulfilled sale and settled cancellation refund,
then creates two unseen invoices. One is paid and confirmed while the host
is absent; the other stays unpaid through rescan. After recovery, it checks
the original store identity, attribution, first receipt, settled refund,
unknown unpaid invoice, no historical address reuse and another batch
through certificate verification and local relay delivery. Reports bind
the source hashes and combined U1(b)/relay-seed subs binary digest. Retained
evidence contains public certificates and reports, never wallets, cookies,
runtime secrets or raw logs. Fixed expected outcomes are not model results.

This exercises known mined history with intact off-host recovery material.
It does not establish the complete operator acceptance gate: several spaces
with simultaneous in-flight/unknown sends, mempool loss, backup corruption,
Infisical loss, buyer-client recovery, a packaged replacement host and the
remaining pilot production cases are separate requirements. Test duration
on a small regtest chain is not a production synchronization estimate or
proof of the four-hour recovery target. Paid sales stay closed.
