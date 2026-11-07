# Draft upstream submission: attach a known txid to the last commitment

Status: draft, not sent. It is for the `subs` maintainers, to accept or
reshape, as `docs/spec/CONTROLLER-DESIGN.md` (U1) says. Sending it is the
owner's decision.

## Issue

### A later commitment restored without its txid stops the space

`subs` stores a commitment's txid only from the answer to its own
`/broadcast` (`commit` in `core/src/app.rs`) or a fee bump. If that answer
is lost, or the operator restores `subs` from a snapshot taken before the
broadcast, the commitment can be on chain and final while `commit_txid`
stays empty.

For a commitment after the first, `can_commit_local` then refuses every
further local commit with "previous commit not yet submitted on-chain".
Nothing in `subs` can record the txid afterwards, so the space can't issue
again without editing the database by hand. Meanwhile `/pipeline` offers
"Ready to broadcast" for the commitment that is already on chain, so a
second `/broadcast` is only one click away.

Reproduced on a local regtest network with `subs` at `4dcc923` (built
without `test-rig`), `spaced` v0.5.0 and Bitcoin Core 26.0, by the harness
in this repository's `regtest/`:
- runs `continued-pinned-20261107T085046Z-cc9a7a` and
  `continued-pinned-20261107T101052Z-049497`: after a host restore, the
  third commitment of `@test10000` (`idx 2`) is final on chain, and `subs`
  holds no txid for it. With the next handle staged, `POST
  /spaces/@test10000/commit` answers HTTP 500, "cannot commit: previous
  commit not yet submitted on-chain". The report is
  `regtest/runs/continued-pinned-20261107T085046Z-cc9a7a.md`.

The initial commitment (`idx 0`) isn't checked for a txid at all, so the
same loss there lets the next local commit go ahead on a commitment `subs`
can't show was ever sent. That is a separate, smaller point.

## Pull request

### Add POST /spaces/:space/commit/txid

The patch is `subs-u1b-attach-commit-txid.patch`, against `4dcc923`. It
adds:
- `core/src/attach.rs`, with `check_attach` and its unit tests;
- `Operator::attach_commit_txid`;
- the route `POST /spaces/:space/commit/txid {"txid": "..."}`.

It sends nothing and changes nothing else. The route sets `commit_txid` on
the last local commitment only when that commitment has none (the same
txid again is a no-op), and only when all of these hold, read from
`spaced` at the time of the call:
- `getserverinfo` reports `ready`, with `chain.blocks == chain.headers`;
- `getcommitment(space)` carries the local commitment's root, at height H;
- `getnumblockmeta(H)` gives, for the block at H on the node's active
  chain, each transaction's nums changeset. Exactly one transaction's
  `commitments` must commit this space to the local root, and it must be
  the given txid;
- if the operator wallet has a record of the txid, it doesn't contradict
  this: a commit-root event for another space or another root, or another
  height, refuses. A missing record doesn't, because a restored wallet may
  have lost its event history.

So the evidence names the committing transaction itself. Without `spaced`'s
nums block index (`--block-index` or `--block-index-full`), the block comes
back with no transactions, and the attach is refused.

Earlier drafts were withdrawn:
- matching the root's bytes anywhere in the raw transaction;
- `gettxmeta`, which reads only the spaces index and never sees a nums
  commitment;
- "the transaction that made the space's current delegate output at H".
  That one accepts a later transaction that moves the delegate in the same
  block without committing.

### Tests

- `attach::tests`, seven unit tests (`cargo test -p subs-core --lib
  attach::`):
  - the commitment's own transaction is attached, with or without a wallet
    record;
  - a later transaction in the same block that moves the delegate without
    committing is refused, with or without a wallet record or commit event;
  - refused too: a transaction that only carries the root's bytes, another
    space's commitment, a wrong height in the block or in the wallet
    record, stale or missing evidence, a block with no transactions (no
    index), another root, and a block with two committing transactions.
- On regtest, run `combined-20261107T114800Z-d17683` (in `regtest/runs/`),
  with this patch and a `--fabric-seed` patch that points `subs` at a local
  relay. After a host
  restore, the route refused a transaction carrying the root's bytes,
  another space's commitment and an earlier commitment of the same space.
  It accepted the commitment's own txid. The next batch then committed
  locally, was proved, broadcast and finalized, and its certificate
  verified. It was published to the local relay, and its delivery was
  confirmed by a libveritas-verified lookup through that relay. All 169
  required steps agree with the reference model.
- The same scenario with the unmodified `subs`, run
  `continued-pinned-20261107T101052Z-049497`, stops at the blocker.

### Limitations

- Tested on regtest only, with `subs` at `4dcc923` (built against the
  `spaces` crates 0.4.2), `spaced` v0.5.0 with `--block-index-full`, and
  Bitcoin Core 26.0. It hasn't been run with `yuki`, on signet or on
  mainnet.
- It requires `spaced`'s nums block index. Without it the attach is always
  refused, so recovery then needs a manual decision.
- The same-block delegate movement, a wrong height, stale chain state, an
  index-less `spaced` and an ambiguous block are covered by unit tests
  only. They weren't produced on a live chain.
- It trusts `spaced`'s nums index to record each transaction's commitments
  correctly.
- It doesn't change `/pipeline`'s "Ready to broadcast" for a commitment
  that is already on chain. `can_commit_local`'s missing check for the
  initial commitment is also left alone.
- It covers U1(b) only. The idempotent broadcast (U1(a)) and the
  prepare/send split (U1(c)) are separate.
