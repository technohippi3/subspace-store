# Reference model plan (draft, 2026-11-06)

Status: preparation only. No product code exists, and none is written until
the owner decides the repository home and licence (open decision 6). Public
visibility is also a proposal. This file defines the states, events, checks
and case mapping of an executable reference model of `PAYMENT-SPEC.md` (draft
8) and of the controller's journal rules in `CONTROLLER-DESIGN.md` (draft 4).

A model result shows that the rules hold in a simulation. It is not evidence
that real Bitcoin transactions, the upstream software, or buyers behave that
way. Those are listed separately at the end, and no model result is ever
reported as one of them.

## Shape

The model is a pure, deterministic state machine:

    step(state, event) -> (state, effects)

`effects` are the things that would leave the store: a broadcast, a PSBT
export, a publish call, an alert. It has no clock other than block height and
explicit timer events, and no randomness except a seeded generator outside
it. Language and libraries are proposals: a small standard-library model is
quickest to write, and it can later serve as an oracle in differential tests
against the real registry.

## State

Chain:
- blocks by height, each an ordered list of transactions;
- the tip height;
- the store node's mempool;
- every transaction's inputs and outputs, so that conflicts and dependencies
  are real rather than flagged.

Depth is derived, never stored.

Names:
- availability, sale mode, and the fixed-price temporary hold;
- the fulfillment reservation;
- auction generations, each with a frozen configuration, a schedule and a
  status: open, ended, `won` or retired.

Orders:
- recipient and eligibility binding;
- quotes, each with height, locked price, window and script;
- status;
- `price_reserve`;
- the set of `reconciling` reasons;
- payment outputs, by identity.

Refunds:
- obligation groups, each with its attempts. An attempt records inputs,
  outputs, `to_buyer`, fee, `charged`, and whether it is signed, exported,
  broadcast or journaled;
- group status;
- "needs rebuild" and "paused" flags.

Batches:
- members and digest;
- the state from `frozen` to `fulfilled`, with side states;
- the broadcast intent and its outcome.

Persistence:
- an append-only journal, with a flag for off-host acknowledgment;
- snapshots of the whole state.

## Events

- Chain: transaction seen, transaction dropped from the mempool, block mined,
  reorg of depth `k` with replacement blocks.
- Buyer: open order, attach request, pass or fail eligibility, request quote
  (refresh or renewal), redeem voucher, supply refund address, ask for a
  refund.
- Owner: create, end or retire a generation; set mode or availability;
  approve a request; cancel an order; record a loss; abandon a PSBT by
  spending an input to the refund wallet; authorize a supersession; set
  refund funding.
- Controller: freeze, stage and read back, local commit and read back, proof
  done, verify, checkpoint, mark `issuing`, broadcast with outcome `ok` or
  `lost`, reach `d >= 150`, verify certificates, publish a chunk, confirm
  delivery per handle.
- Publish outcomes: sent; refused as oversized (success with 0 published);
  cut at the cap; built against a different tip after a reorg, so "temp".
- Faults: crash at any point, lost response, journal acknowledgment delayed,
  off-host write lost before acknowledgment.

## Checks

Run after every event:
- every authorization satisfied its inequality when it was made;
- each `txid:vout` contributes once to each sum, and its contribution follows
  its current depth;
- at most one temporary hold and one fulfillment reservation per name;
- a cancelled order is never batched, and is never also fulfilled;
- no reservation is released without the evidence the spec requires;
- an ordinary three-confirmation purchase never enters `reconciling`;
- every positive shortfall or exposure has its reason set, in every order
  state, unless the owner has recorded that deficit as a merchant loss. Then
  only a larger deficit raises it again, for the difference (N11, N13);
- `reserved` equals the sum of open group maxima, recomputed from the journal;
- on every chain the simulator can build, at most one attempt per group pays;
- no effect is emitted without an earlier acknowledged journal entry;
- no `/broadcast` or `/rollback-local` effect follows an uncertain broadcast
  for the same commitment;
- before conversion, the provisional winner is the earliest qualifying
  position. After conversion, no later reorg changes the converted winner
  (D24 to D28);
- `/publish` is never called with an empty list, or with more handles than
  the chunk size;
- an order is fulfilled only after its handle's delivery is confirmed
  individually. A reorg between the finality check and a publish call never
  counts as delivery;
- a retired generation never produces a winner, and no fixed-price hold
  exists before retirement;
- a payment shortfall never produces a rebuild, replacement or rollback
  effect for a commitment that may have escaped.

Restart and replay. At every step of every run, the model also crashes,
restores the latest snapshot plus the acknowledged journal, reconciles
against the simulated chain, and continues. It doesn't require identical
intermediate state, because a lost response can legitimately leave an
operation uncertain. It checks three things instead:
- Durable obligations match the run without the crash at the same chain
  state, or differ only by an operation the recovered run marks uncertain.
  Those obligations are fulfillment reservations, group reservations,
  recorded refunds, cancellations, retired generations and recorded losses.
- Every state the recovered run enters is a permitted recovery state, such
  as `broadcast_uncertain`, "needs rebuild" or paused.
- No economic effect is duplicated on any chain the simulator can build: no
  name issued in two commitments, no refund group paid twice, no payment
  counted twice.

Repeated calls are allowed where they are idempotent: rebroadcasting the same
signed bytes, a repeated `/ack` or `/committed`, or republishing the same
final certificate. A journal entry lost before acknowledgment must leave its
effect unemitted.

Determinism. The same seed and events give the same states and effects.

## Generated sequences

A seeded generator mixes buyer, owner, chain and fault events. Reorg depths
are drawn so that shallow reorgs are common and reorgs of seven blocks or
more appear in every long run. It also has scripted patterns:
- conflicting spends of refund inputs;
- one transaction paying several orders;
- payments at the last block of a quote window;
- rounding plateaus and early floors;
- quotes outstanding when an auction ends;
- crashes between journal write and acknowledgment.

A failing run is saved as its seed and the shortest failing prefix of events,
found by truncation, and is added as a named regression case.

Required round trips include:
- a payment backing a refund reservation moving from six confirmations to
  five and back (R11, R15);
- a settled refund attempt moving from six to five and back (R16);
- a winner's payment moving from three to two and back (D28, N4).

## Case mapping

Every named case in `PAYMENT-SPEC.md` becomes an executable test with its
identifier as the test name.

| Cases | Area | Runs in the model |
| --- | --- | --- |
| P1 to P13, Q1 | fixed-price payments and holds | yes |
| F1 to F5 | refund arithmetic | yes |
| N1 to N12 | issuance and refund sufficiency, post-issuance deficits | yes |
| G1 to G11 | obligation groups | yes |
| R1 to R16 | refund reconciliation | yes, with simulated transactions |
| D1 to D35 | Dutch auction | yes |
| X1 to X9 | cancellation against issuance | yes |
| B1 to B5 | batch entry and binding check | yes, against a simulated `subs` |
| J1, J2 | restore against reservations | yes, with simulated host loss |
| E1 to E4 | evidence and disclosure | yes, with a real signature library for receipts |
| eligibility (README) | proof binding and quotas | yes, with a stubbed verifier; local ZKPassport verification is an integration test |

## What the model can't establish

Needs real Bitcoin transactions, on regtest or signet first:
- that refund dependency spends and shared-input replacements are valid
  transactions (R9, R12 to R14);
- fee-bump behaviour of the chosen wallet;
- mempool eviction and rebroadcast.

Needs the upstream software, on a local regtest network where possible:
- the controller cycle against `subs` and `spaced`;
- the U1 behaviour;
- publish calls and certificate verification with `libveritas`;
- restore against `subs`' health check;
- the operator gate.

`subs` has a `/rpc/mine` route, which suggests regtest support, but that is
still to confirm.

Needs mainnet with the owner's authorization:
- a commitment on a real throwaway space;
- the buyer gate with Nacho, which runs on mainnet.

Needs buyers:
- clean-install recovery;
- import on other phones;
- whether the checkout copy is understood.

## Local integration harness (preparation)

This prepares the second column of evidence, the upstream software, without
funds or mainnet. It needs no repository decision to plan, but its code
lives in the product repository too.
- Components: `bitcoind` on regtest, `spaced` v0.5.0 against it, and `subs`
  at `4dcc923` with a local prover. `subs` exposes `/rpc/mine` and
  `/rpc/bitcoin`. Whether `spaced` and `subs` run end to end on regtest is the
  first thing to confirm.
- Scenarios, in order:
  1. one initial commitment of two names;
  2. a later commitment that needs proving;
  3. `/broadcast` with its response dropped, to observe what `subs` and the
     wallet do, without retrying blindly;
  4. a reorg across a commitment before and after `d >= 150`;
  5. publish chunks, an oversized batch and a reorg between check and
     publish;
  6. a host loss and restore from snapshot plus journal, which is the
     operator gate's rehearsal.
- Refund transactions: build the shared-input and dependency replacements
  from R9 and R12 to R14 as real regtest transactions, and confirm that at
  most one can be mined on any chain.

## Next steps

1. The owner decides the repository home, licence and visibility.
2. Then create the repository, and write the model and the case tables as
   tests in the order of the mapping table: payments, refunds, auctions,
   batches, restore.
3. Report results by case identifier, labelled "model".
