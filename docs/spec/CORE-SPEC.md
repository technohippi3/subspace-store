# Bitcoin Core observation boundary

The TypeScript adapter observes the payment wallet and allocates new
bech32m destinations. It does not create or unlock wallets, sign or send
transactions, import descriptors, or authorize sales. Runtime cases use a
loopback RPC protocol stand-in. A separate isolated Core 31.2 regtest
qualifies the actual RPC behavior; it is not the complete store/controller
regtest, a deployment or buyer acceptance.

## RPC and readiness

Core 31.2, the repository pin, is required. Configure the expected network
and existing descriptor wallet explicitly. RPC uses HTTP on loopback only,
with no URL credentials, redirects or remote control-plane connection.
The cookie is reread for every call, including after node restart. Cookies
remain local startup-generated credentials, as the Infisical contract says.
Requests have unique response identifiers, bounded response sizes and a
timeout; Effect interruption aborts the request. Errors retain only method,
failure category and numeric RPC code. Node response/error text and
authentication values are not returned or logged. Irreversible calls are
not retried by this client.

Reject wrong versions/networks, initial block download, a wallet rescan,
unloaded mempool, wrong wallet identity and a wallet not processed through
the observed tip. Missing/error responses never mean zero payments. The
caller retains its previous persisted observation when the read fails.
All recorded destinations, including cancelled orders, must still belong
to the payment wallet with their expected scripts.

## Complete receipt observations

Read `listsinceblock` from the beginning with change included, then the
wallet's retained decoded transactions. Unlike address-book receipt RPCs,
this also covers owned addresses absent from the address book after public
descriptor recovery. Filter
every matching output by its exact script and immutable `txid:vout`.
Do not use unspent outputs or a truncated `listtransactions` result as
payment history: spending a receipt does not remove it from the ledger.
Wallet-owned raw transactions need no global transaction-index lookup for
this observation path; other stack/recovery operations retain their own
requirements. BTC output decimals retain their original JSON number text
before exact integer-satoshi conversion, including exponent notation.
Reject sub-satoshi, negative or above-supply values.

A confirmed transaction must have an active block header whose height and
confirmation count agree with the sampled tip. An unconfirmed transaction
contributes only while `getmempoolentry` finds it. Only that RPC's explicit
not-found code means absent; connection, authentication, warmup and other
errors fail the observation. Old receipts stay recorded but inactive when
their transactions disappear. Reorgs and replacements update the active
outpoints without double counting them.

Sample the tip, wallet readiness and relevant receipt/transaction positions
around the read. Changed tips, receipt discovery or relevant mempool
membership retry at most three complete reads, then refuse. Unrelated
mempool traffic does not force a retry. This is an observed view checked
against Core's active chain, not an RPC-wide database snapshot. A later
payment is picked up on the next poll. Core entry time/height do not create
an on-time store observation or automatically extend a recovered hold.

## Evidence and remaining work

`npm run test:core` uses the checksum-pinned binary and a fresh regtest data
directory inside a loopback-only network namespace. It exercises payment
observation, three-confirmation conversion, reorg and re-mining,
spent receipts, replacement, node restart and mempool persistence. It
retains run directories under `regtest/.run/`. CI and pilot readiness run
the same qualification. `regtest/fetch-bitcoin.sh` fetches just the Core
binary without building subs or spaced.
Hosted CI uses `in-netns-ci.sh` to create the network namespace with sudo,
then drops to the runner's original UID/GID with cleared supplementary
groups, a reset environment and no-new-privileges before Node or Core starts. Version
probes and test nodes use an explicit empty configuration. The normal local
command uses unprivileged user/network namespaces.

The adapter is wired through the application's destination-aware snapshot
interface. Refund funding/spend-family observations, registry callbacks,
full application recovery, attended maintenance and the deployed-stack
acceptance gates remain. The hold-recovery/Infisical-outage scenarios in
`deploy/README.md` are not established by this narrower qualification.

## Runtime cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| Z13 | local cookie RPC with redirects, changed credentials, malformed replies, large/slow responses or an interrupted caller | perform calls | use current cookie, match reply IDs, never forward credentials, bound/abort work and return scrubbed typed failures |
| Z14 | several matching outputs and historical receipts, with reorg/mempool changes and exact BTC decimals | observe | retain spent receipts, count each vout once, exclude absent transactions and convert exact whole sats without floating-point money loss |
| Z15 | Core or wallet not ready, wrong chain/version/identity, or an unowned destination | observe or allocate | refuse; preflight failure makes no address-allocation RPC |
| Z16 | tip, relevant receipt discovery or transaction position changes during reading | observe | retry complete reads up to three times; never return a partial result |
| Z17 | malformed wallet/transaction data, missing responses or RPC failures | observe | fail closed; only explicit mempool not-found becomes absence |
| Z18 | the application has historical payment destinations and a prior persisted observation | read through the adapter, cancel and inject a later RPC failure | include historical destinations and keep prior persisted records unchanged on failure |

RPC behavior is qualified against the
[Core 31.2 wallet source](https://github.com/bitcoin/bitcoin/blob/v31.2/src/wallet/rpc/transactions.cpp)
and [mempool source](https://github.com/bitcoin/bitcoin/blob/v31.2/src/rpc/mempool.cpp).
