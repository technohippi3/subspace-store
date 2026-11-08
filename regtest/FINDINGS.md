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
calls them with the pinned build. R19 is how publication was isolated
after all, with a 14-line patch. `/fees` also calls mempool.space and is
never called.

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

R18. Which transaction made a commitment. `gettxmeta` reads `spaced`'s
spaces block index, which records spaces-protocol transactions only
(`get_indexed_tx` in `client/src/rpc.rs`). A commitment transaction is a
nums transaction, so `gettxmeta` returned nothing for it, although the
harness runs `spaced` with `--block-index-full`. An earlier version of this
finding blamed a missing block index. That was wrong. Nums transactions are
in the nums block index, which `getnumblockmeta(height)` reads. For the
block at that height on the node's active chain, it gives each
transaction's nums changeset, including the commitments the transaction
made (`spaces_nums::TxChangeSet.commitments`, each with its space and state
root). The changeset's fields are the same in the `spaces_nums` 0.4.2 that
`subs` builds against and the 0.5.0 that `spaced` runs. Without a block
index the block comes back with no transactions.

The patch went through three drafts:
- the first relied on `gettxmeta`, and refused the true txid;
- the second matched the root's bytes anywhere in the raw transaction;
- the third took the transaction that made the space's current delegate
  output.

Review found that the third accepts the wrong transaction. If another
transaction moves the delegate later in the same block without
committing, its txid passed, and the commitment's own was refused. The
pinned protocol allows that sequence. So which output holds the delegate
isn't evidence of which transaction committed (R22).

The smallest change: U1(b). `regtest/upstream/subs-u1b-attach-commit-txid.patch`
applies to `subs` at `4dcc923`. It adds `core/src/attach.rs` (the pure
`check_attach`, with seven unit tests), `Operator::attach_commit_txid`, and
the route `POST /spaces/:space/commit/txid {"txid": ...}`. The route
attaches a txid to the last local commitment only when it has none (the
same txid again is a no-op), and only when all of these hold, read from
`spaced` at the time of the call:
- `getserverinfo` is `ready`, with `chain.blocks == chain.headers`;
- `getcommitment(space)` carries the local root, at height H;
- in `getnumblockmeta(H)`, exactly one transaction's changeset commits this
  space to the local root, and it is the given txid.

Without the nums block index there is no such evidence, and the attach is
refused. A deployment that relies on U1(b) has to run `spaced` with
`--block-index` or `--block-index-full`.

The operator wallet's record of the txid, where it has one, must not
contradict that. A commit-root event for another space or root, or another
height, refuses. A missing record doesn't, because a restored wallet may
have lost its event history.

The unit tests (`cargo test -p subs-core --lib attach::`, seven pass) cover:
- the commitment's own transaction, which is attached;
- a later transaction in the same block that moves the delegate without
  committing, refused with or without a wallet record or commit event (the
  regression for R22);
- copied root bytes;
- another space's commitment;
- a wrong height;
- stale, missing or index-less evidence;
- another root, and an ambiguous block.

It sends nothing and changes nothing else. `regtest/build-u1b.sh` builds it
alone, and `regtest/build-combined.sh` builds it with the `--fabric-seed`
patch. `upstream/U1B-SUBMISSION.md` is the draft issue and pull request,
with its limitations.

R22. The delegate output doesn't identify the commitment. A commitment
spends the space's delegate output and makes the new one at output 0, but
any later transaction that spends that output in the same block, without
committing, becomes the delegate output's maker, with the same height. A
check built on "the transaction that made the current delegate output at
the commitment's height" accepts that later transaction. This was
reproduced against the patch's predicate, not on a live chain. The patch
now uses the nums block index (R18).

On regtest with the third draft, run `continued-u1b-20261107T101924Z-2f11b7`
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

## Publication and delivery

R19. The pinned `subs` has no way to name its relays, and that is the only
blocker. `run_normal` in `subs/src/main.rs` at `4dcc923` calls
`Operator::new(...).with_fabric()`, which is `Fabric::new()`, which is
`Fabric::with_seeds(SEEDS)` with the two public seeds in
`fabric-resolver` 0.2.10 (`rust/src/seeds.rs`, `relay-cosmos` and
`relay-atlas` at `spacesprotocol.org`, over HTTPS). There is no flag,
environment variable or `/config` key for them. `export_message` builds a
fresh client from the same seed list. `subs-core` already has
`Operator::with_fabric_seeds`, which the `test-rig` mode uses for its
in-process relay, but `test-rig` also brings its own `bitcoind` and a
non-pinned `spaced` (R1). Redirecting the default seeds isn't an option
either: they are HTTPS names checked against public roots. So isolation
needs an upstream change, and
`regtest/upstream/subs-fabric-seed.patch` is the smallest one: 14 added
lines that add `--fabric-seed <url>` (repeatable) to `subs` and call
`with_fabric_seeds` when it is given, logging "Using fabric seeds". Without
the flag, `subs` behaves as before. The relay side needs no change: the
pinned `certrelay`, at `fb44648` (the commit `subs` locks), uses no seeds
on regtest unless `--seed` is given (`relay/src/app.rs`). The harness runs it
in the run's namespace with `--chain regtest --is-bootstrap`, on
`127.0.0.1`, against the run's `spaced`. `build-relay.sh` builds both, the
patched `subs` from a separate clone of the pinned checkout. What the pinned
`subs` would do inside the namespace, where the public seeds are
unreachable, was not run. The patch, like U1(b), is for the maintainers to
accept or reshape.

R20. Publication through the local relay, in run
`publication-20261107T094250Z-76605c`. For each of two batches (b1, the
initial commitment, and b2, a later one that needed a step proof), the
controller followed steps 1 to 6 of the publication procedure:
- the outstanding set held the member whose certificate had verified, and
  was journaled;
- immediately before each call, `getcommitment` for the batch's root and
  Bitcoin Core's position of the transaction showed the root at
  `d >= 150`, with a root anchor 144 past it;
- `POST /spaces/@test10000/publish {"handles": ["one"]}` answered
  `handles_published: 1, remaining: 0`, and
  `/spaces/@test10000/handles/one` then read `publish_status: "final"`.
  The same for `two`;
- the live check ran again, then the relay's `GET /query` answer for the
  space and the handle was verified with libveritas 0.4.4 against root
  anchors read from `spaced` directly. Handle, `script_pubkey`, the space
  zone's root and height, and `sovereign` all matched, and the order became
  `fulfilled`;
- a second pass with nothing outstanding made no `/publish` call.

For b2, publication was refused at `d = 149` (L1) and again at `d = 150`
while the newest anchor was 140 blocks past the commitment (L6), and went
ahead once an anchor covered it. All 30 required steps of the scenario, and
all 62 of the run, agree with the model. `subs` builds two certificates for
a one-handle chunk, the space's and the handle's. The message for one handle
was 2,113 bytes after the initial commitment and 226,260 bytes, 43.2% of the
512 KB relay limit, after the proved one, so the proof's receipt dominates
it. Step 3's chunk of 100 is a count, while the relay limit is in bytes. A
larger chunk, and the halving on `handles_published: 0`, were not
exercised. This is one relay. Propagation between relays, the public relay
network, buyer import and the buyer gate's verifying client were not
exercised. The lookup here is the harness's own: the relay's answer
checked with the pinned libveritas.

R21. A relay answers for a handle it doesn't hold with a message that
verifies. Before `one` was published, the relay's `/query` for
`@test10000,one@test10000` answered HTTP 200 with a message that libveritas
verified, holding the space's zone (with no commitment) and no zone for the
handle. So "the lookup verified" is not delivery. A controller must find the
handle's own zone and compare its `script_pubkey` and the root, as step 6
says. The harness does, and recorded the attempt as not confirmed (L3).
The pinned `certrelay` also met R15 here: two of its anchor refreshes read
`spaced`'s anchors file mid-write ("EOF while parsing") and were retried
at the next refresh.

R23. Relays serve certificates against the space's current root. In the
combined run `combined-20261107T113909Z-345992`, the earlier batches b1 to
b3 were published and looked up only after b6, a later commitment of the
same space, had been made. The relay's `/query` answer for each handle
verified with libveritas, with the handle, the buyer's script and
`sovereign` all correct. But the space's zone carried b6's root and height,
not the root of the batch that issued the handle. The harness compared the
batch's root, so delivery wasn't confirmed and the run failed at those
rows. CONTROLLER-DESIGN.md step 6 said the same ("handle, `script_pubkey`
and root"). Both then took the space's live commitment as the
certificate's root, without checking that root's own depth or anchor
coverage; R24 corrects that. The batch's own root is still required on
chain at `d >= 150` by the live check before each publication and delivery.

R24. The root a certificate is built on is chosen when the handle is
published, and it can be younger than the batch's. In the pinned `subs`,
`publish_certs` (`core/src/app.rs`) issues each certificate against the
space's latest on-chain commitment at the time of the call, and marks the
handle "final" when the handle's own commitment index is at or below that
commitment's, at any depth. A reviewer showed with stubbed answers that the
harness then confirmed delivery with the batch's root at depth 748 and the
certificate's root at depth 149. The live run
`combined-20261107T145828Z-92636d` reproduced it on regtest. b7 was final
and covered, and its member's handle was published while b8, the next
commitment of `@test10000`, was at `d = 149`. `subs` reported the handle
"final". The relay's answer verified with libveritas, with the handle and
the buyer's script correct, under b8's root at height 4684. libveritas
answered "pending" for the handle, because no anchor covered b8.

With the corrected check, the harness refused delivery at `d = 149` and
again at `d = 150` before an anchor covered b8, and the model (new case L9)
refused both too. It confirmed delivery once b8 was covered. The run still
failed at those two rows, because the harness counted libveritas's
"pending" as a mismatch and alerted, where the specification says waiting.
That classification is fixed. Delivery now requires the root the relay's
answer carries to be a commitment of the space on the active chain, at
`d >= 150`, with a root anchor that covers it, and the handle to be
sovereign. A matching answer that falls short of any of these is waiting,
not alerted. Publication still checks only the batch's own commitment, so
a handle can be published while a later commitment is young. Delivery then
waits for that later root.

## Signed records

R25. A relay accepts a message whose records don't verify. In run
`records-20261108T161951Z-0c9721` the pinned `certrelay` answered `200 ok`
to `/message` for a message carrying a record set signed with a key other
than the handle's. libveritas drops such a set without failing the message,
and the relay's later `/query` answers carried no records from it. It also
answered `200 ok` to an older owner-signed set sent after a newer one, and
kept the newer. So a relay's acceptance shows only that the message
verified, not that its records were taken: a record counts only when the
relay's answer, verified against the operator's own root anchors, carries
it, equal to what was signed. The verifier reports a carried set that was
dropped (`dropped` in its `records` output), so a verified message with no
records isn't mistaken for a check that passed.
