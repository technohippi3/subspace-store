# Journal-only application restore and recovery inspection

This extends `STORAGE-SPEC.md` and the existing host-loss rules for the
TypeScript store. The governing independent recovery model is
`ts/model/recovery.ts`. Python's frozen store baseline is unchanged.
These commands recover and inspect a quarantined application database;
controller/subs reconciliation and the whole-host acceptance gate remain
separate work. They cannot clear quarantine or open sales.

## Restore contract

Stop and fence the old store before restoring. Restore into a fresh local
database path with the original off-host journal and the recorded financial
configuration. This is recovery of an installation's history, not a way to
start another seller with the same wallet or journal. The current commands
accept only the existing strict regtest runtime configuration.

```text
node ts/src/main.ts restore <config.json>
node ts/src/main.ts recover <config.json>
```

`restore` takes exclusive ownership before touching SQLite or the journal.
It refuses an existing target or database sidecar, an empty/malformed
journal, unknown records/fields, invalid relationships and mismatched
financial configuration. Complete replay and application validation happen
in the working database before atomic publication. An invalid working file
is retained as evidence, but never becomes the target. The source database,
wallets and certificate cache are not inputs. Sequence, store identity,
order-link hashes, addresses, refunds, signed bytes, arms, closures,
commitments, supersession proofs and first fulfillment remain in history.

After publication, one ordinary changed-record transaction records recovery
quarantine, the global sales pause and an empty pending selection. It
preserves every sale, cancellation, financial reservation and one-use arm.
The marker records the pre-normalization journal sequence and is itself
journaled. Its source sequence must precede the marker in the recovery
history. Normalization is idempotent, including after process death or lost
acknowledgment. A later recovery read resumes a published database whose
normalization was interrupted; repeating restore never overwrites it.

An invoice without durable detection becomes `unknown`; an order without
an address remains `none`. Any durable detection, including a historical
payment row, remains `detected` even if that output is absent now. A payment
seen only in lost, unacknowledged state is unknown unless fresh Core evidence
finds it again. Unknown is never evidence of nonpayment. Buyer JSON for an
unknown invoice withholds its payment address rather than requesting
another payment. Fresh detection can advance unknown to detected, never
back to none. The future browser view must explain this uncertainty.

Certificate bytes are reconstructible cache, not proof of current readiness.
Restore invalidates their recorded verification and requires a newer
observation before fresh verification. Ready orders return to issuing;
fulfilled orders retain their status, first receipt and price reserve and
open a durable application-restored incident. It does not undo cancellation,
release an attempted entry, or manufacture a new issuance permission.

## Read-only chain inspection

`recover` requires an existing database marked for restore reconciliation.
It refuses ordinary or missing targets. It repeats normalization, then
checks live journal acknowledgment before fresh chain work. It requires a
coherent payment-wallet snapshot: the pinned Core version/network, loaded
mempool, completed wallet scan at the node tip, ownership of every recorded
destination and complete wallet receipt history. Cached payment balances
are replaced by these observations. No mempool entry time or hold-observation
timestamp is invented. An unseen or expired invoice does not become unpaid
evidence merely because the wallet sees nothing now.

Every stored signed refund member is observed, including an unattempted
one. A missing observation adapter, RPC failure, malformed result or moving
tip refuses a current report. Retain exact bytes, group/family reservations,
send intents and uncertainty. Observation never signs, retries, broadcasts,
allocates an address, imports descriptors or selects new refund funding.
The inspection instance strips mutation capabilities and never escapes as
an ordinary store. Supersession ancestry is rechecked; certificate validity
is not restored by cached bytes or a mere lookup. Existing clocks and
reconciliation rules still apply, without inventing payment evidence.

The bounded JSON receipt contains version, ready, restore_required,
sales_paused, phase, acknowledged, sequence, chain, orders, issuance,
refunds and waiting. Ready is always false. Restored phase has no current
chain or settled-refund count; observed phase reports the coherent tip and
current aggregate settlement count. It exposes no bearer links, signed
transactions, funding proofs, wallet credentials or certificate bytes.
Waiting always includes controller_reconciliation, and includes missing
chain observation or journal acknowledgment when applicable.

Exit 0 means the command produced an acknowledged receipt, not that service
may resume. Exit 2 reports pending journal durability; run recover once the
journal is available. Exit 1 reports failure without a successful receipt.
Neither command opens listeners or fetches operator/subs bearer credentials.
Normal runtime startup continues to refuse these restored databases.

## Older copies and live permissions

The journaled recovery marker also quarantines an older coherent database
on replay, even if its local restore bit was absent or cleared. There is
no SQL-flag workaround in the supported workflow. Live journal confirmation
refuses when the remote head is ahead of the local outbox, acknowledged
history has disappeared, or the local and remote heads conflict. An older
running copy therefore cannot turn an old matching prefix into permission
for another address, issuance or refund send after detecting newer history.

This is an additional consistency barrier, not a distributed ownership
lease. It does not replace fencing the old host. A process which wrote a
conflicting local tail requires inspection; the tool does not erase it.
The eventual controller-completion protocol must reconcile armed entries,
uncertain sends, roots, wallets and recovery incidents before any durable
quarantine-clear operation is introduced. That operation is absent here.

## Evidence

The independent model checks pause, payment-history uncertainty,
certificate invalidation and irreversible fulfillment separately from
production reducers. Production tests use real SQLite, journals, killed
processes and the shipped commands with recording Core adapters. Separate
Core qualification restores into a new database from the journal alone,
finds a payment made while the store was stopped, rereads settled refunds
and checks that descriptors, balances, coin locks and mempool stay unchanged.
Core and its wallet remain live in that scenario. It does not demonstrate
wallet onboarding-backup restore, subs/controller restore, a lost host,
buyer-client recovery or authorization to deploy or sell.

## Cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O78 | acknowledged and unacknowledged invoices, detection and cancellation | restore journal-only | preserve only acknowledged transitions and identifiers, pause admission, detected stays sticky and other invoices become unknown |
| O79 | invalid domain records, changed financial configuration, invalid recovery provenance or orphan sidecar | restore | refuse before publishing a target; preserve journal and existing evidence |
| O80 | unknown invoice | quote or inspect, then detect and lose a payment | no new address/payment request; detected becomes sticky after real observation |
| O81 | saved signed refunds and uncertain sends | inspect recovery, retry or lose RPC | reread each member; preserve exact bytes, reservation and send history; no signing, allocation or send; unknown outcomes keep quarantine |
| O82 | ready and fulfilled certificates with missing local cache | restore and inspect | withhold verification, relock ready, preserve fulfilled receipt/reserve and arms; one incident reason, no automatic readiness |
| O83 | published restore | kill before or after normalization journal publication, then recover | quarantine survives; one durable normalization, same orders and no duplicate sequence on retry |
| O84 | shipped restore/recover commands | run, repeat restore and attempt normal startup | bounded receipt and clean process exit; no listeners or wallet mutation; no controller-gate bypass |
| O85 | ordinary/missing database, journal outage or incoherent/unavailable Core | recover | refuse current readiness and preserve quarantine/evidence |
| O86 | normalization append unavailable after publication | restore and later recover | exit pending with unacknowledged receipt; subsequent command acknowledges the same transition without sending |
| O87 | older coherent database or stale live writer | encounter journaled quarantine or newer/conflicting head | old startup refuses; clearing a local bit is insufficient; live permissions and new address allocation withhold |
