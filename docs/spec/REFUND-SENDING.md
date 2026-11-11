# TypeScript first-attempt refund sending

This extends `REFUND-PREPARATION.md` with the existing broadcast and
reconciliation rules in `PAYMENT-SPEC.md`. `REFUND-FAMILIES.md` now extends
it to all saved members, fee bumps and exclusive rebuilds. The refund
deadline lifecycle, general alerts/loss recording and full host-loss
recovery remain unfinished. This component does not open paid sales.

## Intent and sending

An operator-only command runs under the store's serialized Effect queue.
There is no operator HTTP route or raw transaction export. It reads payment
and refund evidence at the same tip hash/height before deciding. Known
mempool or mined transactions are observed rather than sent again. An
unknown input spend blocks sending. A conflict seen at six confirmations
permanently marks the group as needing a rebuild; a later reorg does not
clear that guard or authorize an independent refund.

Before the first send, current settled credit must still cover the group's
charge. Every send/retry writes an uncertain intent with the group's
immutable transaction ID and an incrementing intent count, then flushes
and confirms the journal. Core checks readiness and decodes the stored
signed bytes against the recorded inputs, sequences, outputs and virtual
size. A second live journal check runs immediately before `sendrawtransaction`,
after preflight verifies that Core still has the observation's hash and height,
with no intervening RPC. An accepted reply is recorded afterward. A refusal,
lost reply, interrupted caller or process death leaves the intent uncertain;
none releases funds. Intent count is not a count of network transmissions.

Startup reconciles existing signed refund history before returning a ready
application. If journaled send/observation history exists but its adapter is
missing, startup refuses. Reads never send. The explicit reconciliation
command retries only previously attempted, currently absent transactions
whose inputs remain available and whose group is not guarded by a conflict.
It uses exactly the original signed bytes and never signs a second payment.
Previously built but unattempted refunds are not automatically broadcast.

## Evidence and balances

The Core reader scans complete wallet history, including change, without
UTXO or pagination truncation. It checks each relevant transaction against
active block headers or the mempool, and identifies other wallet spends of
the refund's inputs. Only explicit transaction/mempool not-found codes
represent absence; other RPC failures refuse. A missing input with no
identified spender remains unavailable, never evidence for release.
History, transaction positions, input availability and Core/wallet readiness
are bracketed around each read. Detected changes retry at most three reads.
Payment and refund observations must agree on hash and height before any
application changes commit. This is a checked observed view, not an
RPC-wide atomic snapshot.

At six confirmations a group's charge moves from reserved to refunded.
Losing settlement moves it back, without changing the signed group or
releasing its charge. Available funds and refund exposure are recomputed
from these observations. Confirmed admission exposure subtracts only
settled refunds; losing settlement restores the charge to that cap. Order
views expose these amounts, chain status, intent count and uncertainty,
with separate acknowledgments for the signed group and latest send intent,
without signed bytes. Issuance shortfalls are distinguished from shortages
after entry into issuance; neither automatically cancels or reallocates a
name. Durable owner alerts and merchant-loss handling remain release work.

Full application restore still refuses pending controller/chain recovery.
Unconverted excess remains unsupported, and this increment does not claim
complete recovery or automatic maintenance, deadline
enforcement or complete pilot acceptance. No deployment defaults or migration
framework were introduced.

The process-death test also found a journal-backend reuse bug: `read()`
scanned another owner's new entries without updating its append cursor.
Successful durable readback now updates that cursor after directory fsync.
A reused backend can therefore continue a journal advanced by a killed
process; failed readback still cannot adopt an entry.

## Runtime cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| Z27 | a built refund and journal loss before intent acknowledgment or during preflight, or lost settlement before the first intent | send | transmit nothing; preserve uncertain intent/reservation when one exists |
| Z28 | an input conflict observed at settled depth | restart or reorg the conflict | keep the reservation and sticky rebuild guard; never send an independent payment |
| Z29 | saved payment/refund facts | an RPC read fails or payment/refund tip hashes disagree | refuse and preserve the previous application records |
| Z30 | absent, mempool, confirmed or conflicted refunds in complete wallet history | read through Core RPC | identify positions and settled conflicts without inferring release from spent/missing inputs |
| Z31 | journaled signed bytes | send through Core RPC | validate their identity and evaluate live permission immediately before the send call |
| Z32 | lookup errors, malformed spends or incomplete wallet history | observe refunds | fail closed; only explicit not-found responses become absence |
| Z33 | changing wallet discovery or input availability | observe refunds | retry complete reads at most three times, then refuse |
| Z34 | a process past its acknowledged send gate | SIGKILL, reopen and reconcile | retain uncertain intent and charge, retry the same signed transaction without rebuilding |
| Z35 | confirmed receipts at the admission cap | settle a refund, then lose its settled depth | reopen admission only after settlement and restore the cap when settlement is lost |

The pinned Core regtest additionally exercises application sends with a
lost first reply, store restart, settlement changing 6–5–6, a deeper refund
reorg/re-mining, and a later refund funded from proven change. These use
fresh isolated regtest wallets. They are not full host-loss recovery.
RPC semantics are checked against the Core 31.2
[wallet transaction source](https://github.com/bitcoin/bitcoin/blob/v31.2/src/wallet/rpc/transactions.cpp)
and [raw transaction source](https://github.com/bitcoin/bitcoin/blob/v31.2/src/rpc/rawtransaction.cpp).
