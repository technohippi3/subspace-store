# Private purchase on mainnet (plan, draft 2026-11-10)

Status: a plan. Nothing in it has run. It changes no rule and opens no
sales. Every step that moves funds or changes on-chain state needs the
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

All of it on one machine the workspace_owner controls, with every
listener on loopback, as the service and the runner already require. The
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
  without one. Open question: whether the node available has both. The
  buyer gate's `spaced` syncs through a remote Bitcoin RPC, and a hosted
  RPC may give neither wallet calls nor an index. A node of its own means
  a full sync with the index, several hundred gigabytes and a day or more.
- `spaced` v0.5.0 and `subs` at the pinned commit, as the buyer gate's
  test operator runs them (`buyer-gate/operator.sh`), confined, with the
  `operator-2` wallet. One purchase on a space with no restore needs no
  U1(b).
- The Python store service and the attended runner, with the reviewed
  controller. The TypeScript store isn't complete, and this test needs
  only one purchase.
- The journal and snapshot directories, on storage separate from the
  store's database. For a private, attended purchase that is a separate
  disk or mount, not yet a separate store with its own credentials; the
  operator gate still needs that.
- The public relay the buyer gate's M6 lookup used, for publication and
  the verified delivery lookup.

## Code changes before anything runs

Each is local work, tested before use, and none opens anything to the
public.

1. Mainnet, behind an explicit switch. The service refuses every network
   but regtest (`service/__main__.py`), and so does the runner
   (`runner/cli.py`, `NETWORKS` and `NAMES`). Both accept mainnet only
   with a configuration key that names it a private attended test, and
   still listen on loopback only. The runner's network check maps
   mainnet's names: `main` for Bitcoin Core, and the names `spaced`,
   `subs` and the store report.
2. Fee rates the operator sets. `issue` defaults to 1 sat/vB today. On
   mainnet the fee rate must be given, and the runner refuses one above a
   configured ceiling. The same goes for refunds, whose fee is a fixed
   300 sats today. Estimating fees with `estimatesmartfee` is the pilot
   decision, but this test can use explicit fees.
3. A durable allowance for exactly one order. An exposure limit can't do
   this: a reviewer reproduced, with the real ledger, a 1,000-sat quote
   under a 1,100-sat limit expiring, exposure falling to zero, and a
   second quote accepted, with both payment addresses given out. So the
   test configuration names the one order it allows, by handle and
   recipient script. The store quotes that order once. Asking again
   returns its existing invoice, and the order stays payable, late
   payment included, under the usual rules. Nothing else is ever quoted,
   and the allowance is recorded and journaled when it is used, so
   neither the hold's expiry, a cancellation, a restart nor a restore
   frees it for another order. The hot-wallet cap is set to the test
   price.
4. One boundary for all four: the clean VM or separate machine, with the
   store and the runner installed in it beside `spaced` and `subs`, and
   with no host wallet directory shared into it. The confinement checks
   are repeated there.
5. Validation. Tests that the service and the runner refuse mainnet
   without the switch, and refuse a listener off loopback with it. Then
   the regtest service, checkout and recovery scenarios again with the
   changed code, since they are the evidence that nothing else moved.

## Transaction budget

Two sizes are measured, from the signed bytes the regtest runs
journaled. On mainnet the same transactions have the same shape, as long
as the operator wallet funds a commitment from a single input:
- a commitment: 256 vbytes, the same in all 138 measured (2 inputs: the
  delegate output and the funding; 3 outputs: the delegate output, the
  root, the change);
- a refund: 111 vbytes, the same in all 21 measured (1 input, 1 output).

Not measured, and each still to estimate before the transaction plan is
authorized:
- the buyer's payment, which depends on the buyer wallet (a one-input,
  two-output Taproot payment is about 154 vbytes);
- funding the operator wallet, about the same;
- the Spaces transactions that operate the space and delegate it to the
  test operator (the buyer gate's M1), which `space-cli` builds;
- returning what is left in the operator wallet afterwards.

What the fee comes to, at a few fee rates the workspace_owner might
choose on the day:

| Fee rate (sat/vB) | Commitment | Payment (estimate) | A refund, if one is tried |
| ---: | ---: | ---: | ---: |
| 2 | 512 | 308 | 222 |
| 5 | 1,280 | 770 | 555 |
| 10 | 2,560 | 1,540 | 1,110 |
| 20 | 5,120 | 3,080 | 2,220 |

So the purchase itself costs the price, 1,000 sats, which comes back to
the workspace_owner, plus the commitment's and the payment's fees:
roughly 800 to 8,200 sats across those rates. That isn't the whole
budget: the space's operate and delegate transactions, the funding and
the return come on top, and are estimated before authorization. A
suggested limit, for the workspace_owner to set: fund the operator wallet
with 10,000 sats, which covers one commitment of the measured shape at up
to 20 sat/vB with room to spare and nothing more, and set the fee-rate
ceiling at the rate the mempool asks for on the day. Funds left
afterwards return to the workspace_owner by a transaction they authorize
then.

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

1. The code changes and their tests, then the regtest scenarios again.
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

- Which Bitcoin Core node the store uses. A reviewer recommends checking
  first what the node available can do, a synced index and wallet access,
  before choosing a new sync.
- Which clean VM or machine. A reviewer recommends a clean VM with no
  existing wallet directory shared into it.
- Whether the buyer gate or the purchase runs first on the space. A
  reviewer recommends the purchase first, on the unused throwaway space:
  it tests the goal directly, and its commitment, the space's first,
  needs no proof. The buyer gate's procedure assumes the first commitment
  (`docs/BUYER-GATE.md`, "Why this shape") and would then need updating.
- The fee-rate ceiling and the operator wallet's funding.
- The authorization of the filled-in transaction plan.

None of these is decided, and none needs to be before the local work: the
mainnet switch, the fee-rate ceiling and the one-order allowance, with
their tests. That work doesn't depend on the pilot decisions recorded in
`docs/spec/PAYMENT-SPEC.md` either.
