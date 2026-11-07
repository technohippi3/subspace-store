# Regtest findings against the specification

Findings from building and running the regtest harness against the pinned
upstream software. Each one is labelled "regtest": it was observed on a
local regtest network, or by reading the pinned source while building the
harness. None is model, integration, mainnet or buyer-acceptance evidence.
They are findings against `docs/spec/`. The reference model was not changed
to match any of them.

## The open points in "Still to confirm before building"

R1. Regtest support in `subs`. `/rpc/mine` and `/rpc/bitcoin` exist only in
a `subs` built with its `test-rig` feature (`subs/src/routes/console.rs`). That
mode starts its own `bitcoind`, downloaded by the `bitcoind` crate that
`spaces_testutil` uses, runs `spaced` in process from the spaces git commit
`16fb1f5` rather than v0.5.0, and starts an in-process certrelay. Without the
feature, both routes answer 503. So `subs` runs on regtest, but its own
regtest mode doesn't use the pinned `spaced`. The harness builds `subs`
without `test-rig`, points it at a separately started `spaced` v0.5.0, and
mines through Bitcoin Core's RPC.

R2. Version skew between the pins. `subs` at `4dcc923` builds against the
spaces crates 0.4.2 (crates.io, and git `16fb1f5` for the test utilities),
not v0.5.0. `16fb1f5` is two commits before `spaces_client-v0.5.0`, and the
RPC difference between them is one optional parameter, `committed_fallback`
on `buildchainproof`. The harness ran `subs` against `spaced` v0.5.0 without
a call-shape failure. The specification pins `libveritas` at `61281f1`,
which is the merge that released `libveritas` v0.4.5, while `subs` locks
`libveritas` 0.4.4. The certificate check here uses 0.4.4, the version
`subs` itself verifies with. The pins should name the versions that are
actually built together.

R3. The `spaced` v0.5.0 call shapes the adapter needs:
- `getdelegation(subject)` returns a num id (`num1...`). On a space that the
  preset chain never delegated it returned a num id for which `getnum`
  returned null, so a delegation is only established once `getnum` returns
  the output.
- `getnum(num_id)` returns the delegate output as `txid` and `n`, with
  `spent`. After a commitment is mined it follows the new delegate output,
  which is output 0 of the commitment transaction.
- `getcommitment(subject, root|null)` returns `state_root`, `prev_root`,
  `rolling_hash` and `block_height`, for mined commitments only. It returns
  null while the commitment transaction is in the mempool.
- `walletsendrequest` with a `commit` request returns
  `result[].txid` and an event `{"type": "commit_root", "space", "root"}`.
  `fee_rate` is in sat/kwu (250 is 1 sat/vB). Without a fee rate, regtest
  refuses with "could not estimate fee rate", so `/broadcast` must always be
  given one.
- The commitment transaction spends the delegate output and a funding
  input. Its outputs are the new delegate output (same script), an
  `OP_RETURN OP_2 <32-byte root>` and change.
- `walletlisttransactions(wallet, count, skip)` lists the operator wallet's
  unconfirmed commitment transaction, with `block_height: null` and the
  `commit_root` event carrying the root.
- `gettxmeta(txid)` refuses a mempool transaction ("Could not retrieve
  block hash for tx (is it in the mempool?)").

R4. Mempool lookups. `spaced` has no mempool call, as the design says, and
`gettxmeta` refuses unconfirmed transactions. The operator wallet's
transaction list does show an unconfirmed commitment with its root, and
Bitcoin Core answers the mempool lookup directly (`getrawmempool` and
`getrawtransaction`). A deployment with a full Bitcoin Core node can answer
the readback. With `yuki` this is still open.

## Upstream defects found while building

R5. `spaced` v0.5.0 sends the contents of `--bitcoin-rpc-cookie` as the HTTP
Basic token without base64-encoding it (`client/src/source.rs`,
`BitcoinRpcAuth::Cookie(cookie) => Some(cookie.clone())`, while user and
password are encoded). Bitcoin Core answers 401 and `spaced` never syncs.
The harness gives `spaced` a throwaway `rpcauth` user made for each run,
passed through environment variables. Worth reporting upstream.

R6. Publication can't be exercised without contacting the public relay
network. A `subs` built without `test-rig` creates its fabric client with
the default seeds (`Operator::with_fabric` in `subs/src/main.rs`), so
`/spaces/:space/publish` and `/query` go to public relays. The harness never
calls them, and the publication procedure stays unexercised on regtest.
`/fees` also calls mempool.space and is never called.

R7. `subs` listens on every interface. At the pinned commit the HTTP server
binds `0.0.0.0` with no option to change it (`subs/src/main.rs`,
`SocketAddr::from(([0, 0, 0, 0], port))`). The design requires `subs` and
`spaced` to listen only on the host's private interface. With `subs` as it
is, that needs a firewall rule or a network namespace, or an upstream bind
option. During harness runs the regtest `subs`, with its upstream test
wallet, is reachable from the local network.

## Shapes the controller must use

R8. Handle readback is by label. `GET /spaces/:space/handles` and
`/spaces/:space/handles/:handle` report and take the handle's label alone
(`one`, not `one@test10000`), and `/park` takes labels too. Unknown
`filter` values are ignored and return every handle. A controller that
compares full names with this readback parks its own members; the harness
did exactly that in its second run before the comparison was fixed.

R9. In a verified certificate message the committed root is on the space's
zone, not the handle's. libveritas returns one zone for `@space`, with the
commitment root and height, and one for `name@space`, with the
script_pubkey and sovereignty and no commitment. The certificate check in
CONTROLLER-DESIGN.md ("it proves inclusion in the batch's root ... that root
is the one in the mined transaction") is met by comparing the space zone's
root and height with the batch record, within the same verified message.

## Lost finality

R10. A final commitment removed by a deep reorg did not come back. On
Bitcoin Core 26.0, after `invalidateblock` disconnected the 151 blocks from
the commitment's block to the tip, the commitment transaction was not in the
node's mempool, although `testmempoolaccept` still accepted its bytes. The
reference model assumes a disconnected commitment returns to the mempool and
is mined again (L1 then L2), and the regtest run disagreed at that step.
Part of this may be specific to `invalidateblock`. A natural reorg to a
competing chain normally re-adds disconnected transactions, and that was not
tested. The gap behind it is real either way. Nothing in `subs`, the `spaced`
wallet or the controller design would rebroadcast the commitment.
`/broadcast` is rightly forbidden once a send may have happened. MODEL-PLAN
allows "rebroadcasting the same signed bytes", but the controller doesn't
journal those bytes (U1(c) would). The specification should say how a
commitment that lost finality gets back on chain: rebroadcast of journaled
bytes, or the owner's decision. Until it does, L2 depends on the transaction
surviving in someone's mempool. In the harness run the identical bytes were
resubmitted by the harness, standing in for a peer that kept the
transaction, and the report marks that step as a harness action.

R11. A certificate can be "pending" at d >= 150. libveritas judges
sovereignty from the newest root anchor it is given
(`newest_anchor - commitment_height >= 144`), and `spaced` computes an anchor
every 36 blocks (`COMMIT_BLOCK_INTERVAL`). In the fourth run the commitment
was mined at 3606, the tip was 3756 (d = 150, and `subs` said `finalized`),
but the newest anchor was 3744, 138 blocks on, so libveritas returned the
handle as `pending`, not `sovereign`. Every other check passed. The
controller's finality (d >= 150 by the tip) and the certificate's
sovereignty (144 past the commitment, measured at the latest anchor) can
disagree for up to 35 blocks. The specification should say which one makes
a member "ready". Until it does, a controller must not treat `pending` at
d >= 150 as a failed verification and pause the space. It should verify
again once an anchor covers the commitment. The harness records the failing
check, mines to that anchor, and verifies again as a separate step.

## Proving

R12. `subs`' proving loop doesn't start proofs. At the pinned commit the
background loop (`subs/src/background.rs`, `proving_loop`) only polls a job
that already has a job key, and the branch that would submit one is
disabled along with the estimates. A proof is submitted only through
`POST /spaces/:space/proving/push`, once for each proof: a step, then a
fold for a commitment after the second. CONTROLLER-DESIGN.md step 4 ("let
the proving loop or a remote prover run. Poll `/pipeline`") should say that
the controller pushes each proof and then polls. A harness run that only
polled waited with no job until it was stopped. `subs-prover`, like `subs`,
binds every interface (`0.0.0.0`).

## Restore and the lost answer

R13. `subs` offers to broadcast a commitment that is already on chain. In
run `all-20261107T072937Z-12277c`, after the host restore (the snapshot
predates the broadcast) and after the lost answer from `spaced`, `subs` had
the local commitment with no txid. Its `/commit/status` said `none`, and
its `/pipeline` said `current_step: broadcast` with "Ready to broadcast",
although the commitment was mined, and in the restore case final. The tree
root `subs` restored matched the chain's root. An operator following the UI,
or any caller of `/broadcast`, would build and send a second commitment for
the same root. The controller's rule never to call `/broadcast` again is
the only thing preventing that. U1(b), a way to attach the known txid,
would let `subs` show the truth.

R14. How the lost commitment was adopted, and what it needed. In the same
run, `spaced`'s answer to `subs` was dropped, so `subs` answered HTTP 500 and
stored no txid. The controller's readback found the transaction twice: in
its own node's mempool (`getrawmempool` and `getrawtransaction`, a spend of
the delegate output carrying the root), and in the operator wallet's
`walletlisttransactions` (an unconfirmed transaction with a `commit_root`
event for the root). `getcommitment` was null, because the transaction was
not yet mined. The controller adopted the txid in its own journal. That
needed neither U1(b) nor a manual repair, because nothing was written to
`subs`. `subs` never learned the txid. It still built a certificate for the
member, because it builds certificates from the chain's state, and
libveritas verified it, so the order reached ready. What the missing txid
does to the space's next commitment is probed in later runs (step "U1(b)").
The earlier probe in this run only showed "no staged changes to commit",
because nothing was staged.

R15. `getrootanchors` can fail mid-write. `spaced` v0.5.0 rewrites
`root_anchors.json` in place (`fs::write` in `client/src/store/chain.rs`)
while `getrootanchors` reads the same file (`client/src/rpc.rs`). In run
`all-20261107T075023Z-f6dfd6`, a read just after a new anchor block answered
"Could not read anchors file: EOF while parsing a string", and the run
ended in error. A verifier or controller that reads anchors from `spaced`
must retry that error, and the file should be written atomically upstream
(write to a temporary file, then rename). The harness now retries that one
error and counts the retries.

R16. `subs` checks a previous commitment's txid only after the first. In
`can_commit_local` (`core/src/app.rs`), a previous commitment without a txid
blocks the next local commit only when its `idx > 0` ("previous commit not
yet submitted on-chain"). The initial commitment (`idx 0`) is checked for
neither a txid nor its presence on chain. In run
`all-20261107T075152Z-248f89`, after the lost answer on `@test9999`, whose
only commitment is initial and has no txid in `subs`, a dry run of the next
local commit was allowed with a member staged. So `subs` would build a
second commitment on an initial one it can't show was ever sent.
CONTROLLER-DESIGN.md's "refuses ... if the previous commitment has no
transaction ID yet" holds only after the first commitment. For a later
commitment restored without its txid (the restore scenario, `idx 2`), the
code refuses the next local commit until a txid is attached, which is U1(b).
That half comes from reading the code. It wasn't run.

## Continued operation after recovery

R17. A later commitment restored without its txid stops the space. In run
`continued-pinned-20261107T085046Z-cc9a7a`, after the host restore, the
last commitment of `@test10000` (b3, `idx 2`) was final on chain, and the
controller had adopted its txid in its journal, but `subs` held none. With
the next order converted and staged, `subs` refused the next local commit:
"cannot commit: previous commit not yet submitted on-chain" (HTTP 500 from
`POST /spaces/:space/commit`). The pinned `subs` has no way to be told the
txid, so the space can't issue again without a manual database repair.
This confirms the code reading in R16 by a run. The reference model allows
the commit, because the previous commitment is final, so that step is a
required disagreement and the run's verdict is "fail". This is the blocker
the run was meant to show.

R18. `gettxmeta` needs `spaced`'s block index. `spaced` v0.5.0 answers
`gettxmeta` only when it runs with `--block-index` or `--block-index-full`
(`client/src/store/chain.rs`). The harness runs it without, as a deployment
might, so `gettxmeta` returned nothing for the mined commitment. The first
draft of the U1(b) patch relied on it and refused the true txid. The second
draft fell back to matching the root's bytes anywhere in the raw
transaction, and to the operator wallet's record without its space. Review
showed that doesn't establish which transaction made the commitment. Both
are gone.

The smallest change: U1(b). `regtest/upstream/subs-u1b-attach-commit-txid.patch`
applies to `subs` at `4dcc923`. It adds `core/src/attach.rs` (the pure
`check_attach`, with six unit tests), `Operator::attach_commit_txid`, and
the route `POST /spaces/:space/commit/txid {"txid": ...}`. The route
attaches a txid to the last local commitment only when it has none (the
same txid again is a no-op). It decides from chain state read from `spaced`
at the time of the call:
- `getserverinfo` is `ready`, with `chain.blocks == chain.headers`, so the
  view isn't stale;
- `getcommitment(space)` carries the local root, at height H;
- the space's delegate output, from `getnum` on its delegate's num id, is
  output 0 of the given txid, unspent, with `last_update` H. A commitment
  spends the delegate output and makes the new one at output 0, so only
  the transaction that committed at H can be named there.

The operator wallet's record of the txid, where it has one, must not
contradict that. A commit-root event for another space or root, or another
height, refuses. A missing record doesn't, because a restored wallet may
have lost its event history. The unit tests refuse copied root bytes,
another space's commitment, a wrong height (in the delegate or the wallet
record), stale or missing chain evidence, another root, another output and
a spent delegate output (`cargo test -p subs-core --lib attach::`, six
pass). It sends nothing and changes nothing else. `regtest/build-u1b.sh`
builds it as `.cache/bin/subs-u1b` from a separate worktree of the pinned
checkout. `upstream/U1B-SUBMISSION.md` is the draft issue and pull request,
with its limitations.

On regtest with this patch, run `continued-u1b-20261107T101924Z-2f11b7`
refused three impostors, each because it "didn't make this space's delegate
output": a transaction from the buyer's wallet whose `OP_RETURN` carries
the bytes `6a 52 20` and b3's root, the commitment of `@test9999`, and b2,
an earlier commitment of `@test10000`. It then attached b3's adopted txid.
The next batch (b6, `idx 3`) committed, was proved with a step and a fold
(100 s), broadcast and finalized, waited for anchor coverage, and its
certificate verified, so the order is ready. The verdict is "pass", with
all 119 required steps agreeing with the model. With the pinned `subs`, run
`continued-pinned-20261107T101052Z-049497` refused the same three, because
it has no route at all, and then failed at the blocker: 104 of 105 required
steps agree. The earlier draft's runs, `...085046Z-cc9a7a` and
`...085107Z-645ce5`, are kept too. The patch is for the maintainers to
accept or reshape, as U1 says.
Until they do, a deployment needs either this patch or an owner-authorized
repair after any restore that loses a later commitment's txid.
