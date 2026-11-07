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
adds `core/src/attach.rs`, with `check_attach` and its unit tests,
`Operator::attach_commit_txid`, and the route
`POST /spaces/:space/commit/txid {"txid": "..."}`. It sends nothing and
changes nothing else. The route sets `commit_txid` on the last local
commitment only when that commitment has none (the same txid again is a
no-op) and all of these hold, read from `spaced` at the time of the call:
- `getserverinfo` reports `ready`, with `chain.blocks == chain.headers`, so
  the chain state isn't stale;
- `getcommitment(space)` carries the local commitment's root, at height H;
- the space's delegate output (`getnum` on the delegate's num id) is output
  0 of the given txid, unspent, last updated at H. A commitment spends the
  delegate output and makes the new one at output 0, so only the
  transaction that committed at H can be named there;
- if the operator wallet has a record of the txid, it doesn't contradict
  this: a commit-root event for another space or another root, or another
  height, refuses. A missing record doesn't, because a restored wallet may
  have lost its event history.

An earlier draft matched the root's bytes anywhere in the raw transaction.
That draft is gone: the binding now comes from chain state, not from
transaction bytes.

Tests:
- `attach::tests`, six unit tests (`cargo test -p subs-core --lib
  attach::`): the right transaction is attached, with or without a wallet
  record. Refused are a transaction that only copies the root's bytes,
  another space's commitment, a wrong height in the delegate or in the
  wallet record, stale or missing chain evidence, another root, another
  output index and a spent delegate output;
- on regtest, run `continued-u1b-20261107T101924Z-2f11b7` (in
  `regtest/runs/`): after the same restore, the route refuses a transaction
  carrying the root's bytes, another space's commitment and an earlier
  commitment of the same space. Each refusal says the txid "didn't make
  this space's delegate output". It accepts the commitment's own txid. The
  next batch then commits locally, is proved with a step and a fold,
  broadcast and finalized, and its certificate verifies with libveritas.
  All 119 required steps agree with the reference model. The same scenario
  with the unmodified `subs`, run
  `continued-pinned-20261107T101052Z-049497`, stops at the blocker.

### Limitations

- Tested on regtest only, with the versions above. `subs` at `4dcc923`
  builds against the `spaces` crates 0.4.2 while running against `spaced`
  v0.5.0. It hasn't been run with `yuki`, on signet or on mainnet.
- If another transaction moves the delegate output in the same block,
  after the commitment, the delegate output names that transaction and the
  commitment's own txid is refused. That fails safe, but needs a manual
  decision.
- A wrong height and a stale chain view are covered by unit tests only.
  They can't be produced honestly on a live regtest chain.
- It doesn't change `/pipeline`'s "Ready to broadcast" for a commitment
  that is already on chain. `can_commit_local`'s missing check for the
  initial commitment is also left alone.
- It covers U1(b) only. The idempotent broadcast (U1(a)) and the
  prepare/send split (U1(c)) are separate.
