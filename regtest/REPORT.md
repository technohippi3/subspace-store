# Regtest report

Label: regtest. Every result here comes from the pinned Bitcoin Core 26.0,
`spaced` v0.5.0 and `subs` at `4dcc923` on a local regtest network, driven
by the harness in this directory. None of it is model, integration, mainnet
or buyer-acceptance evidence. The harness's registry and controller are
harness code, not the product. Findings are in `FINDINGS.md`, and the full
step tables, with the model's expectation beside each regtest result, are in
`runs/`.

Handle labels. The harness names test handles `one`, `two` and so on. The
runs before that change used personal first names as labels. Those labels
are replaced word for word in the committed copies of their reports and
logs, and nothing else in those files is changed. Hashes, roots, txids and
scripts are as recorded.

## Milestone: the first bounded regtest purchase (run fp4)

What run fp4 demonstrates, on regtest: a public recipient request, a
fixed-price quote, a regtest payment, issuance through the real `subs` and
`spaced`, finality at d >= 150, and a certificate verified with libveritas,
all the way to the member being ready.

What it doesn't demonstrate:
- relay publication (R6);
- buyer import, in Nacho or any other client;
- completed delivery: no member reached "fulfilled";
- proving: the initial commitment skips it, so no proof was made or
  verified in fp4;
- automatic recovery: the L2 resubmission of the commitment was a harness
  action, standing in for a peer (R10).

fp4 ran before the harness was tightened. It ran outside a network
namespace, while `subs` listened on every interface (R7). It had no
required or informational split and no exit-status verdict. Its run
directory is still kept locally, uncommitted, and its report is copied into
`runs/`. The directories of attempts 1 to 4 (fp1 to fp3) were deleted
between runs, before the rule never to delete one, and only their console
logs, plus attempt 4's JSON report, are kept in `runs/`. The stopped
all-scenario run all1 is kept too. It reached b2's local commit and was
stopped unisolated, before any proof. Runs after it use the tightened harness described below.

## First purchase (run fp4, 2026-11-07)

Script: `regtest/run-first-purchase.sh`. Full table:
`runs/first-purchase-fp4.md` and `.json`.

Each step and its regtest result:

1. Public recipient request for `one@test10000` with the buyer's taproot
   script: accepted as order o1.
2. Fixed-price quote: 10,000 sats to a fresh store address, temporary hold
   taken. A second quote for the held name was refused "taken for now"
   (Q1, as the model expects).
3. Regtest payment from the buyer's wallet: at 1 confirmation the order
   stays quoted. At 3 it converts to a fulfillment reservation (P1, as the
   model expects).
4. Freeze, then stage through `subs`' `/registry/sync` with the registry
   serving exactly the batch member, read back as staged with the buyer's
   script.
5. Local commit through `subs`: initial commitment, root read back on the
   member. Proving was skipped by `subs`, as it is for an initial commitment.
6. Checkpoint: `subs` stopped, its data directory and both databases copied
   and checked by SHA-256, `subs` restarted.
7. Binding check passed. The member was marked `issuing` and its mark and
   the broadcast intent were both acknowledged in the off-host journals
   before the one `/broadcast` (B3, as the model expects). A cancellation
   afterwards was refused (X3, as the model expects).
8. The commitment was mined, was not final at d = 149 and was final at
   d = 150. `subs` reported `finalized`.
9. Certificate: the message `subs` builds for the handle, verified with
   libveritas 0.4.4 against root anchors read from `spaced` directly. The
   handle, the buyer's script_pubkey, the batch root and its mined height
   and sovereignty all checked. The member became ready, as the model
   expects.

The same run then exercised lost finality:
- L1: a 151-block reorg took the commitment off the best chain. The batch
  returned to `broadcast`, the member to `issuing`, and cancellation and
  certificate verification were refused, all as the model expects.
- The model expects the commitment back in the mempool, and it was not
  (finding R10, a recorded disagreement). The harness resubmitted the
  identical signed bytes, standing in for a peer that kept them.
- L2: mined again, final again at d = 150, as the model expects.
- The certificate check then failed on sovereignty alone, because the
  newest root anchor lagged the tip (finding R11, a recorded disagreement
  with the d >= 150 rule). After mining to the next anchor it passed, and
  the member was ready again.

## How the first purchase got there

Earlier attempts, kept so their failures stay on record:
- Attempt 1 (fp1): the harness's staging readback compared full handle names
  with `subs`' label-only readback and parked its own member. That was a
  harness bug (R8 records the shape). The run stopped at staging.
- Attempt 2 (fp1, `runs/attempt-2-first-purchase.log`): the certificate
  verified, but the harness read the commitment root from the handle's zone,
  where libveritas never puts it (R9). That was a harness bug: the root was
  on the space's zone and matched. The run then stopped, because a test
  reorg to a shorter chain, which can't happen on a real network, left
  `spaced` at its old tip. The run's JSON report was deleted when its
  directory was cleared, and only the console log is kept.
- Attempt 3 (fp2, `runs/attempt-3-first-purchase.log`): the root check
  passed, and R10 appeared. The run stopped because nothing returned the
  commitment to the chain.
- Attempt 4 (fp3, `runs/attempt-4-first-purchase.*`): R11 appeared after L2.
  This run's `testmempoolaccept` result is not meaningful, because the
  harness's negative fee delta was still applied.
- Attempt 5 (fp4): the run above.

## All scenarios (run all-20261107T075846Z-ff80d4, 2026-11-07)

Script: `regtest/run-all.sh`. Full table: `runs/all-20261107T075846Z-ff80d4.md`
and `.json`. Isolated in a network namespace, after `main` (e0fa5ee, with
L6 to L8 and X10) was merged. Verdict: pass, exit 0, all four scenarios
completed. 98 required steps all agree with the model. 16 steps are
informational. Five of those 98 rows were weaker than their label in this
run. The quote row checked only that the model accepted a quote. The
freeze row checked only that the model's freeze succeeded, without
comparing members. The local-commit row was hardcoded to agree. The L1 and
L6 refusal rows compared with a constant instead of asking the model. All
five now compare the actual fields (`harness/compare.py`), and
`tests/test_regtest_compare.py` shows that a mismatch on any field fails
the run with exit status 1. The corrected comparisons haven't been rerun
against the live stack yet. One `getrootanchors` read hit the half-written file (R15)
and was retried. Proving took 79 s for b2 and 125 s for b3 in this run.
The run before it, `all-20261107T075152Z-248f89`, gave the same verdict
with the same counts, before the labels were changed. Its relabelled
report is also in `runs/`, and its proving times (about 35 s and 141 s)
appear below. Cases compared: P1, Q1, B3, B6, X3, X4, J3, J4, L1, L2, L6,
L7.

1. First purchase: as in fp4, now with the two gates for ready. L6 at
   d = 150 was "verified" the first time, because the anchor at 3600 covers
   3454. After the reorg it was "awaiting_anchor": verification was refused
   and the member stayed `issuing` until the anchor at 3780. For L7, the
   node did not have the commitment after the reorg (R10, informational).
   `/broadcast` was refused, the controller rebroadcast the identical
   signed bytes it had journaled when it first saw the transaction, and a
   second rebroadcast was refused while the transaction was in the
   mempool.
2. Second commitment with a proof (b2, o3 and o4): the controller pushed
   one step proof to `subs-prover` (R12), and CPU proving took about 35 s.
   B6: no second batch while b2 was open. J3: with the store's journal down,
   nothing was sent and b2 waited in `issuing`. A resume was refused while
   the journal was down, and once both journals acknowledged, exactly one
   commitment was sent. Both certificates, which carry the proof's receipt,
   verified with libveritas, and o3 and o4 became ready.
3. Host loss and restore (b3, o5): a step and a fold proof took about 141 s.
   The host's databases and the `subs` data directory were deleted after
   the broadcast, then restored from the checkpoint snapshot, which
   predates the broadcast, plus both journals. J4: o5 was `issuing` and its
   cancellation was refused. The restored tree root equals the chain's
   root, but `subs` has no txid, and its pipeline offers "Ready to
   broadcast" for a mined commitment (R13). b3 reached final, and o5 became
   ready.
4. Lost broadcast response (b4, o6, on `@test9999`): `spaced`'s answer to
   `subs` was dropped. `subs` answered HTTP 500 and stored no txid, and the
   batch became `broadcast_uncertain`. X4: cancellation, `/broadcast` again
   and `/rollback-local` were all refused. The readback found the
   transaction in the node's mempool and in the operator wallet, and the
   controller adopted the txid in its journal alone, with neither U1(b) nor
   a manual repair (R14). The batch reached final and o6 became ready. With
   a further order (o7) staged, `subs` allowed a dry run of the next local
   commit, although it holds no txid for the initial commitment (R16).

What the full run does not show: relay publication, buyer import,
completed delivery, X10 (a supersession undone by a reorg deeper than 6),
L8 (no journaled bytes, recovery paused), a controller-side lost answer
from `subs` (only `spaced`'s answer to `subs` was dropped), refunds, late
payments, hold extensions, eligibility proofs, auctions, and a natural
competing-chain reorg. Bitcoin Core and `spaced` stayed up through the
"host loss", standing in for the network and for an operator wallet
restored from its onboarding backup.

Earlier all-scenario runs, kept for the record:
- `all1`: stopped unisolated at b2's local commit, before the namespace.
- `all-20261107T070251Z-80b727`: ended in error, a race between the new tip
  and its anchor in the harness.
- `all-20261107T070452Z-f3a757`: stopped, because proving never started
  (R12). Its saved report predates the "did not finish" marker and wrongly
  reads "pass". It did not finish.
- `all-20261107T072937Z-12277c`: passed against the model before the merge.
- `all-20261107T075023Z-f6dfd6`: ended in error, `getrootanchors` reading
  a half-written file (R15).

## Corrected comparisons (run all-20261107T083353Z-06a396, 2026-11-07)

Script: `regtest/run-all.sh`, from `main` at `8c20619`, isolated. Verdict:
pass, exit 0, all four scenarios completed. All 98 required steps agree
with the model, now including the quote, freeze, local-commit, L1 and L6
rows with their actual comparisons. 16 steps are informational. Proving
took 40 s for b2 and 110 s for b3. Report: `runs/all-20261107T083353Z-06a396.*`,
certificates in `evidence/`.

## Continued operation after recovery (2026-11-07)

Script: `regtest/run-continued.sh [pinned|u1b]`. It runs the first
purchase, the second commitment and the host restore, then scenario 5: the
first space's last commitment (b3, `idx 2`) is final, the controller
adopted its txid, and `subs` holds none (R13). One more order is bought, and
the controller tries to issue another batch.

- With the pinned `subs`, run `continued-pinned-20261107T085046Z-cc9a7a`:
  verdict fail, exit 1. 80 of 81 required steps agree. The one that
  disagrees is the blocker: `subs` refused the next local commit, "previous
  commit not yet submitted on-chain" (R17). The model allows it. The
  pinned `subs` has no route to attach the txid (HTTP 404).
- With `subs` patched for U1(b), run `continued-u1b-20261107T085107Z-645ce5`:
  verdict pass, exit 0, all 94 required steps agree. A wrong txid (b2's) was
  refused. The adopted txid was attached. The next batch (b4, `idx 3`)
  committed, was proved with a step and a fold (110 s), broadcast and
  finalized, waited for anchor coverage, and its certificate verified. The
  order became ready.

So recovery restores continued operation only with U1(b). The patch is in
`upstream/` (R17, R18).

Those two runs used the patch's second draft, which review found too weak:
it matched the root's bytes anywhere in a raw transaction, and the
wallet's record without its space. The patch now binds the txid to the
space's delegate output in chain state (R18). It was rerun with scenario 4
first, so that another space has a commitment, and with three impostor
txids tried before the real one:
- `continued-pinned-20261107T101052Z-049497`: verdict fail, exit 1. 104 of
  105 required steps agree. The impostors are refused, because the pinned
  `subs` has no route. The local commit is refused at the blocker (R17).
- `continued-u1b-20261107T101924Z-2f11b7`: verdict pass, exit 0. All 119
  required steps agree, and 20 are informational. Each impostor was refused
  because it didn't make this space's delegate output: a transaction
  carrying the root's bytes, `@test9999`'s commitment, and an earlier
  commitment of `@test10000`. The adopted txid was attached. The next batch
  (b6, `idx 3`) committed, was proved with a step and a fold (100 s),
  broadcast and finalized, and after anchor coverage its certificate
  verified. The order became ready.

Three runs in between ended in harness bugs and aren't kept.
`continued-pinned-20261107T100339Z-dda7d3` and
`continued-u1b-20261107T100411Z-4a4807` ended in error: the miner wallet had
no spendable funds for the impostor transaction, and the buyer's wallet is
used now. `continued-u1b-20261107T101124Z-e6bcf7` failed at L6, because the
model's mirror of `@test10000` wasn't advanced for the blocks mined during
scenario 4. Scenario 5 now brings the mirror to the real tip first, and
records it (it was 183 blocks behind).

## Publication and delivery through a local relay (run publication-20261107T094250Z-76605c, 2026-11-07)

Script: `regtest/run-publication.sh`. Full table:
`runs/publication-20261107T094250Z-76605c.md` and `.json`. Verdict pass,
exit 0. All 62 required steps agree with the model, 30 of them in
scenario 6.

The run uses `subs` with `upstream/subs-fabric-seed.patch` (built as
`.cache/bin/subs-relay` by `build-relay.sh`) and the pinned `certrelay` at
`fb44648`, the commit `subs` locks. Both run inside the run's namespace.
`subs` logged "Using fabric seeds: http://127.0.0.1:18950", the relay had
no seeds and no peers, and nothing in the namespace can reach the public
relay network (R19). The pinned `subs` can't be isolated this way, because
it has no option to name its relays.

After the first purchase (scenario 1, unchanged), scenario 6 follows the
publication procedure for b1, then issues b2 and does the same:
1. The outstanding set for the batch is the member whose certificate
   verified, journaled in the controller's journal.
2. Before publication, a lookup of `one@test10000` through the relay
   answered with a message that verified but held no zone for the handle,
   so delivery was not confirmed. The model refuses delivery of an
   unpublished handle too (L3, R21).
3. Immediately before the call, the live chain carried b1's root at
   `d = 174`, covered by the anchor at 3780. `/publish` with the one-handle
   chunk `["one"]` answered `handles_published: 1, remaining: 0`, and the
   handle's `publish_status` read "final". The model allowed and counted
   the same chunk.
4. The live check ran again, then the relay's `/query` answer was verified
   with libveritas against `spaced`'s anchors. Handle, buyer script, root
   `326b921a...` at 3606 and `sovereign` all matched. The order went from
   ready to fulfilled, and the model fulfilled it too.
5. A second pass with nothing outstanding made no call, as the model
   expects for an empty set.
6. For b2 (order o3, `two@test10000`, a commitment that needed a 50 s step
   proof), publication was refused at `d = 149` (L1) and at `d = 150` while
   the newest anchor was 140 blocks past the commitment (L6), as in the
   model. After mining to the anchor at 3960, the certificate verified,
   publication and delivery went as for b1, and o3 became fulfilled.

In this run the L3 row's regtest side was the constant "not confirmed",
not the result of the delivery path. It now calls the controller's
`confirm_delivery`, which refuses an unpublished handle, and compares that.
The kept run predates the correction and hasn't been rerun.

So two orders reached "fulfilled" on regtest: request, quote, payment,
issuance, finality, anchor coverage, publication to a relay and a verified
lookup through it. The relay messages are kept as evidence and verify
offline. The one-handle message after the proved commitment was 226,260
bytes, 43.2% of the relay's 512 KB limit (R20).

## The tightened harness

Since fp4:
- Every run executes inside an unprivileged user and network namespace
  (`unshare -rn`, `in-netns.sh`) with loopback only. That confines `subs`'
  every-interface listener (R7) and keeps the stack off the network,
  without changing any host firewall, system or security setting. The
  harness refuses to start outside such a namespace.
- Each step is "required" or "informational". A required step that
  disagrees with the model gives the verdict "fail" and exit status 1. An
  error gives "error" and 2. A refusal to run gives 3. The informational
  steps are the R11 anchor-coverage observation and the R10 check for the
  commitment back in the node's mempool, which records a known
  disagreement until the model's L6 to L8 land.
- A member becomes ready only after a root anchor covers its commitment
  (R11). The harness mines to that anchor, then verifies.
- Run ids are unique (`run-id.sh`), and the harness never deletes a run
  directory or reuses one.
- Each certificate verification keeps its own directory under
  `.run/<run id>/certs/`, with the certificate message, the anchors and
  the libveritas output.

## Not exercised

Not exercised on regtest:
- publication beyond one local relay: propagation between relays, the
  public relay network, chunks of more than one handle, an oversized chunk
  and its halving, temp certificates, and a reorg between the live check
  and a `/publish` call (scenario 6 uses one relay and one-handle chunks);
- buyer import, in Nacho or any other client, and the buyer gate's
  verifying client (delivery was confirmed by the harness's own lookup:
  the relay's answer verified with the pinned libveritas);
- a fulfilled order whose commitment then loses finality or is superseded
  (L4, L5);
- refunds of any kind, late payments, hold extensions and eligibility
  proofs;
- a lost answer between `subs` and the controller (only `spaced`'s answer to
  `subs` was dropped);
- X10, a supersession undone by a reorg deeper than settled depth, and L8,
  a lost commitment with no journaled bytes;
- continued operation after a lost answer on a later commitment, rather
  than a restore (scenario 5 covers the restore case, and only with the
  U1(b) patch);
- the U1(b) and `--fabric-seed` patches together: they are separate builds
  (`subs-u1b`, `subs-relay`), so no run has both recovered after a restore
  and published;
- auctions, and a natural competing-chain reorg as opposed to
  `invalidateblock`.

The restore scenario isn't the operator gate. Bitcoin Core and `spaced`
stayed up through the "host loss", the operator wallet wasn't restored
from its backup, and the "off-host" journal and snapshots are another
local directory, not a separate store with per-object confirmation. So it
shows the registry, controller and `subs` restore and reconcile. It doesn't
show a clean-host backup and wallet restore.

## Evidence kept

The run directories under `.run/` are ignored by git. `keep-run.sh` copies a
run's report into `runs/` and its certificate verifications into
`evidence/<run id>/`, with the repository's absolute path made relative. It
never replaces or removes anything already kept: a run id that is already
kept is refused, the copies are checked in a temporary directory before
they're published, and a run id must be a plain name.
`tests/test_regtest_keep_run.py` covers this. The kept runs are the two full
runs, four continued runs and `publication-20261107T094250Z-76605c`. Four
of the publication run's verifications, in its `-relay` directories, are
the relay's `/query` answers from scenario 6: two from before publication
and two from the delivery lookups. Each message is kept with its root
anchors and libveritas output. `verify-evidence.sh` verifies them all offline, and
`evidence/README.md` says how. fp4's certificate isn't kept in the repository,
because its handle label was a personal name and is part of the signed
message.
