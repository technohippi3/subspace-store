# Private purchase on mainnet (plan, draft 2026-11-10)

Status: mainnet has not run. The local implementation is committed and
checked on regtest; the machine, confinement and authorized transaction
budget are still preparation work. This plan opens no sales. Every step
that moves funds or changes on-chain state needs the
workspace_owner's authorization of the filled-in transaction plan below,
and the workspace_owner performs every wallet action personally. No seed
phrase or private key is ever shown to an agent session or written into
evidence.

## What it shows

One purchase through the real store, on mainnet, with the
workspace_owner as the only buyer. A name under a throwaway space is
requested from Nacho, quoted at 1,000 sats, and paid from the
workspace_owner's buyer wallet to a separate store wallet the
workspace_owner also controls. The store detects the payment and
converts the order. The attended runner issues the name: a commitment
from a separately funded operator wallet, a proof if the space needs one,
finality, and a verified certificate. The certificate is delivered to the
order page and published. The workspace_owner then imports it into Nacho
and signs a record update, and the 1,000 sats are in the store wallet.

That is the part nothing has shown yet: the store's own checkout, payment
detection and issuance against the real network, ending in a name a real
client controls.

It doesn't show public sales or anything the public pilot needs: hold
admission, the exposure limit as a business control, refund economics,
the operator gate's recovery, or the TypeScript store. The price is
nominal. It moves from the workspace_owner to the workspace_owner, so it
needn't cover issuance, which the operator wallet funds separately.

It is not the buyer gate either. The buyer gate (`docs/BUYER-GATE.md`)
issues through `subs` directly, bypassing checkout, payment detection
and the store, so it proves the client side, not a sale. The two
complement each other, and much of the buyer gate's preparation is
shared.

## What runs, and where

All of it on one machine the workspace_owner controls. The service binds
to loopback and the runner requires loopback URLs for the local services.
Those URLs do not prove how another process binds its listener. The
buyer gate's preparation recommends a clean VM or separate machine that
shares no host wallet folder; this plan follows that.

The pieces must share one boundary. `buyer-gate/operator.sh` confines
`spaced` and `subs` in a network namespace that the host can't reach and
that can't reach the host's loopback. The store and the runner talk to
`subs` over loopback both ways: the runner drives it, and `subs` asks the
store for the frozen batch (`/pending`) and reports back (`/ack`,
`/committed`). So the store and the runner run inside the same boundary
as `spaced` and `subs`. Running the store on the host beside a confined
`subs` doesn't work.

That boundary is the clean VM or separate machine, not the namespace. A
namespace with all four in it would let them reach each other, but it
isn't a filesystem boundary: the processes run as the workstation's user
and can read every file that user can, its existing wallet files
included (`docs/BUYER-GATE.md`, P2). Inside the VM a namespace may still
confine the network, but the VM is what keeps the test away from wallets
it has no business with.

- Bitcoin Core on mainnet, fully synced with `-txindex`, and with the
  store's wallet. The store reads every payment and refund transaction by
  id (`service/bitcoin.py`). So does the controller, for commitments, their
  unconfirmed ancestors and the operator wallet's transactions, none of
  them in the store's wallet (`controller/core.py`, its
  `getrawtransaction` calls without a block hash). Without the index such a
  transaction is readable while it is in the mempool and unreadable once it
  is mined, and the controller could no longer follow it to finality. So
  the first test keeps an indexed node, and the code isn't changed to do
  without one. The hosted endpoint the buyer gate's `spaced` uses was
  probed read-only on 2026-11-10: Bitcoin Core 29.4.0 on mainnet, synced,
  with its transaction index, but with no wallet methods, so the store
  can't run on it. Decided by the workspace_owner on 2026-11-10: the
  store gets its own full node on the VPS, with the index and the store's
  wallet, on a disk of about 1,200 GB. That endpoint then reported 892 GB
  of block data; the index comes on top and wasn't measured. A pruned
  node or a remote backend is later work, not part of this test.
- `spaced` v0.5.0 and the loopback-binding build of the pinned `subs`
  (`regtest/build-private.sh`), confined, with the `operator-2` wallet.
  The build also includes U1(b) and explicit relay seeds. One purchase on
  a space with no restore needs no U1(b), but recovery does. The buyer
  gate's launcher is separate; it does not select this build automatically.
- The Python store service and the attended runner, with the reviewed
  controller. The TypeScript store isn't complete, and this test needs
  only one purchase.
- The journal and snapshot directories, on storage separate from the
  store's database. For a private, attended purchase that is a separate
  disk or mount, not yet a separate store with its own credentials; the
  operator gate still needs that.
- The public relay the buyer gate's M6 lookup used, for publication and
  the verified delivery lookup.

## Local implementation and remaining preparation

The implementation is committed as `bfa95e9`: the private mainnet switch,
explicit rate limits, durable one-order allowance and controller process
lock. Cases Y1 to Y8 and A23 cover them. The implementation tree passed
253 Python tests, the coverage gate with all 178 fixed-price cases tested,
and the type check and 36 TypeScript tests. The private-mode checkout and
refund, and the recovery rehearsal, passed on regtest. These checks do not
establish mainnet or Nacho acceptance.

The service and runner require matching `private_attended_test`
configuration: network, canonical handle, recipient script, a price of
1,000 sats, a maximum fee rate and an explicit refund rate. The allowance
is consumed with the invoice in one SQLite transaction and acknowledged
in the same journal entry. Expiry, cancellation and restore cannot free
it for another order. The configured name cannot be repriced. A repeated
quote for that order returns the same invoice under the existing payment
rules. Private startup reports pending refund rebroadcasts for attended
action. Each runner command holds the controller lock, so a second one,
even `status`, refuses while the first waits on an RPC.

The clean VM, shared connectivity inside it, recovery storage and network
confinement are still to prepare. In particular, pinned `subs` binds
`0.0.0.0` without a bind-address option (finding R7). A clean VM alone
does not make that listener private. `regtest/upstream/subs-loopback.patch`
changes its bind to `127.0.0.1`. `regtest/build-private.sh` applies that
patch with U1(b) and the relay-seed patch and produces a separate
`.cache/bin/subs-private` under `regtest/`; it leaves existing builds alone.
Review and select that binary explicitly for the VM, keep clients on IPv4
loopback, and use the host firewall as another layer. No firewall or host
is configured by the build. This patch adds no API authentication.

The existing buyer-gate launcher contains only spaced and subs. The strict
listener preflight below still fails on a wildcard bind, including inside
a namespace. Choosing namespace confinement instead of the binding patch
would require a separate reviewed check, not ignoring that failure.

## Read-only preflight

Run this inside the intended VM and network namespace after preparing and
starting the stack, before funding or issuing:

```sh
python3 tools/private_preflight.py STORE_CONFIG RUNNER_CONFIG
```

It reads the two configurations, node sync and transaction-index status,
the loaded store signing wallet, Core's registered wallet directory,
spaced's operator-wallet sync, the store's private configuration, chain
agreement through both subs endpoints, local TCP listeners, mount types
and filesystem device numbers. It requires only the configured store
wallet in that Core node's loaded and registered wallets. It never loads,
creates or unlocks a wallet, constructs a ledger or controller, opens their
databases, signs, broadcasts or starts an application process. Its output withholds
paths, URLs, wallet names, credentials and RPC response bodies.

For a directory not yet created, such as the first snapshot's directory,
it resolves existing symlinks and checks the nearest existing parent.
It creates nothing. Permission errors and paths that are files still
fail. A missing recovery mount on the database filesystem fails too;
the check uses today's mounts, not where a future mount is promised.

Exit 0 and `automated_checks: PASS` mean only those automated checks passed.
Exit 1 means at least one failed or could not be checked. The check covers
configured application ports; an administrative SSH listener is outside
that scope. A wildcard subs listener fails even when clients use a
loopback URL.

The report always retains manual checks. The VM's hypervisor shares,
bind mounts, other wallet files outside Core's registered directory and
physical storage independence cannot be proved by this script. Known
shared-folder filesystem types are flagged, but their absence is not
proof of wallet isolation. Recheck the machine's sharing configuration,
external reachability and the throwaway space separately. This report
never authorizes spending.

The tool has fake-RPC tests and a real regtest read check. The original
regtest fixture fails because it has extra test wallets, wildcard subs
listeners and no separate recovery filesystem. With the private build,
the listener check must pass; the extra wallets and shared recovery
filesystem must still fail. The harness also requires the missing first
snapshot directory to produce a filesystem mismatch, not an error while
looking up the directory. These are detection checks, not a VM preflight
passed.

The patched build and private checkout passed together in regtest run
`private-loopback-20261110T180007Z-37a159`; the order ended fulfilled with
a verified certificate. The old-build control and exact checks are
recorded in `regtest/upstream/LOOPBACK.md`.

## Transaction budget

The earlier signed-byte measurements found 256-vbyte commitments in
138 samples and 111-vbyte refunds in 21 samples. A fresh isolated run,
`private-budget-20261110T171215Z-f74330`, measured the remaining operations
with the pinned builders (`regtest/harness/private_budget.py`):

| Transaction | Measured vbytes | Inputs / outputs | Scope |
| --- | ---: | ---: | --- |
| Operate | 341 | 2 / 5 | Two spaces in the fixture |
| Delegate | 212 | 2 / 2 | Fresh recipient address in the same fixture wallet; size evidence only |
| Fund operator with 10,000 sats | 154 | 1 / 2 | Core selected the input and change |
| Pay the 1,000-sat invoice | 154 | 1 / 2 | Core selected the input and change |
| Commitment | 256 | 2 / 3 | Delegate output and one funding input |
| Partial operator return | 154 | 1 / 2 | A 5,000-sat return with change, not a complete sweep |
| Cancellation refund | 111 | 1 / 1 | The earlier private run paid 222 sats at 2 sat/vB |

These are signed regtest shapes. The delegation measurement does not
prove a handover between separate wallets. The final return's actual
input selection and sweep amount remain unmeasured. Additional inputs,
different change or a different buyer wallet change the sizes. The actual
wallet previews remain part of the transaction plan.

The following figures are `vbytes × rate`, in sats. They are estimates,
not fee ceilings or measured mainnet costs. The builders include small
rounding allowances: the operate transactions paid 342 sats, delegation
213 and the partial return 155 at a requested 1 sat/vB. Core paid 1,550
sats for each 154-vbyte funding/payment transaction at its regtest fallback
rate. Check the actual wallet fee before authorizing each transaction.

| Transaction | 2 sat/vB | 5 sat/vB | 10 sat/vB | 20 sat/vB |
| --- | ---: | ---: | ---: | ---: |
| Operate | 682 | 1,705 | 3,410 | 6,820 |
| Delegate | 424 | 1,060 | 2,120 | 4,240 |
| Fund operator | 308 | 770 | 1,540 | 3,080 |
| Buyer payment | 308 | 770 | 1,540 | 3,080 |
| Commitment | 512 | 1,280 | 2,560 | 5,120 |
| Partial return with change | 308 | 770 | 1,540 | 3,080 |
| Total for these six shapes | 2,542 | 6,355 | 12,710 | 25,420 |

The invoice's 1,000 sats and the operator funding are transfers between
wallets the workspace_owner controls. The table totals the network fees
for this route; it excludes an optional refund and any extra transaction
needed by the chosen wallets. The eventual complete return must be
previewed separately. Its fee comes out of the operator wallet's remaining
spendable coins. The suggested 10,000-sat funding remains a proposal:
choose it against both issuance and return fees, with a margin, rather
than treating all of it as a cost or as approval to spend it.

A refund also has to meet the store's 546-sat minimum output. At the
measured 111 vbytes and 2 sat/vB, 778 sats return to the buyer. At 5 sat/vB,
a 555-sat fee would leave only 445 sats, and the current builder refuses.
The fee rate and spending limits still need the workspace_owner's choice.

Before authorization, complete this table from the actual wallet previews.
A maximum total fee in sats is separate from the requested rate. The
runner limits the requested commitment rate; the funding, buyer-payment
and return wallets have their own fee controls.

| Step | Amount or action | Requested sat/vB | Maximum total fee, sats |
| --- | --- | --- | --- |
| Operate | Chosen throwaway space; preview any new outputs | ____ | ____ |
| Delegate | Confirm the test operator's recipient | ____ | ____ |
| Fund operator | ____ sats | ____ | ____ |
| Buyer payment | 1,000 sats to the store invoice | ____ | ____ |
| Commitment | Exactly the configured order | ____ | ____ |
| Return | Remaining spendable coins, previewed after the test | ____ | ____ |

There is more at stake than fees: the test operator holds funds and
authority delegated over a space. The throwaway space and the separately
funded operator wallet keep that small.

## Which space

The buyer gate's throwaway space. The order matters for one detail. A
space's first commitment needs no proof; every later one does, and
proving runs on the CPU (35 to 141 seconds on regtest for one or two
names). If the buyer gate runs first, its commitment is the first, and the
store's purchase needs a proof. If the purchase runs first, it makes the
first commitment. Either works; proving has worked on regtest.

## Sequence

1. Use the reviewed implementation and its recorded tests. The local
   implementation checks have passed; deploying it is still separate work.
2. The buyer gate's remaining preparation: the clean VM or machine, the
   confinement checks repeated there, and the chain check of the space
   immediately before the first transaction.
3. The store's Bitcoin Core node and wallet, once the node question is
   settled.
4. The transaction plan filled in and authorized. Its first steps are
   the buyer gate's: the space delegated to the test operator (M1) and
   the operator wallet funded (M3). The store can't issue on the space
   before then.
5. The purchase:
   1. list the name at 1,000 sats through the operator API;
   2. request it with Nacho's exported request, and take the invoice from
      the order page;
   3. the workspace_owner pays it from the buyer wallet;
   4. at 3 confirmations, about 30 minutes, the order converts;
   5. the runner prepares the batch: freeze, stage, commit locally, prove
      if needed, and checkpoint;
   6. the runner issues it, with the batch id confirmed and the fee rate
      given;
   7. the runner watches it to 150 blocks deep and to anchor coverage,
      about 25 to 31 hours, then verifies and delivers the certificate,
      and publishes it with a verified lookup through the relay;
   8. the workspace_owner imports the certificate into Nacho and signs a
      record update, which is verified against the certificate;
   9. the store wallet shows the 1,000 sats received.
6. Record the evidence: software revisions, the procedure, and sanitized
   results, never buyer-linked records, recovery material or credentials
   (the pilot decisions on published evidence).

Most of the elapsed time is waiting for finality: about a day and a half
from payment to a name in Nacho.

## Stop conditions

Stop, and change nothing on-chain, when any of these happens:
- a component isn't on mainnet, or isn't on the same chain as the others
  (the runner's network check);
- the fee rate the mempool asks is above the ceiling;
- a broadcast is uncertain. Then readback only, and never a second send
  (cases A20 to A22);
- the certificate doesn't verify against the batch's root and the
  order's script;
- Nacho rejects the certificate, or the signed record doesn't verify.

## Decisions for the workspace_owner

- Which clean VM or machine. A reviewer recommends a clean VM with no
  existing wallet directory shared into it.
- Whether the buyer gate or the purchase runs first on the space. A
  reviewer recommends the purchase first, on the unused throwaway space:
  it tests the goal directly, and its commitment, the space's first,
  needs no proof. The buyer gate's procedure assumes the first commitment
  (`docs/BUYER-GATE.md`, "Why this shape") and would then need updating.
- The fee-rate ceiling and the operator wallet's funding.
- The authorization of the filled-in transaction plan.

The node is decided: a full node of the store's own on the VPS (above).
These choices remain open. The local implementation is complete for the
Python private-test path; the preflight and budget preparation do not
choose a machine, set a spending limit or authorize a transaction. The
TypeScript/Effect runtime for the public pilot is still separate work.
