# Subspace store issuance controller design (draft 7, 2026-11-07)

Status: draft design. Nothing is built. Payment, reservation, cancellation
and refund rules are in `PAYMENT-SPEC.md`, including the depth arithmetic
used here. This file covers how the controller drives `subs`, what it
journals and snapshots, and how it is restored. Draft 2 replaces the assumed
interfaces in draft 1 with the behaviour of the pinned source, read on
2026-11-06. Draft 3 records the `spaces` v0.5.0 calls and finality rule, and
the `subs` publishing behaviour, read the same day. Draft 4 makes
publication complete per handle and corrects the reading of the 144-block
rule. Draft 5 applies the model review of 2026-11-07: both journals before a
broadcast, the check at the moment of every send, one commitment per space,
and lost finality. Draft 6 applies the first regtest findings (R10, R11):
readiness waits for root-anchor coverage, and a commitment's signed bytes are
journaled so it can be rebroadcast after a deep reorg. Draft 7 corrects
the pins and three statements about `subs` against what the regtest
harness found (`regtest/FINDINGS.md` R2, R12, R13, R14 and R16), and
records the candidate U1(b) patch that lets a space issue again after a
restore (R17, R18).

## Pinned upstream versions

- `subs` at `4dcc9237af3a807497d4b1532729842ee5dcdb68`;
- `spaces` v0.5.0 (`spaced`, `space-cli`), released 2026-09-21. `subs` at
  that commit builds against the `spaces` crates 0.4.2, and git `16fb1f5`
  for its test utilities, two commits before v0.5.0. On regtest it ran
  against `spaced` v0.5.0 with no call-shape failure (R2);
- `libveritas` 0.4.4, the version `subs` locks and verifies with. The
  earlier pin, `61281f1`, is the v0.4.5 release merge, which `subs` doesn't
  build (R2);
- Bitcoin Core 26.0, for the regtest harness;
- the RISC Zero toolchain that `subs` pins in its `Cargo.lock` and
  `rust-toolchain.toml`;
- `yuki`, at a version still to be chosen.

Images are pinned by digest. An upgrade is an explicit change with its own
test run, and it repeats the source checks below.

## Upstream behaviour at the pinned commit

Verified by reading the source at `4dcc923`:
`subs/src/routes/{mod,commits,registry,status}.rs`, `subs/src/background.rs`,
`core/src/app.rs`, `core/src/storage.rs` and `REGISTRY.md`.

Local commit (`POST /spaces/:space/commit`) commits every staged handle that
isn't parked. The SQL is `UPDATE handles SET commitment_root = ? ... WHERE
commitment_root IS NULL AND parked = 0`. It refuses if the space has an
on-chain commitment it doesn't know, if the previous commitment lacks its
proof, if a previous commitment after the first has no transaction ID yet,
or if the previous commitment is on chain with `d < 150`. The initial
commitment is checked for neither a transaction ID nor its presence on
chain (R16). So `subs` doesn't stop a local commit after an initial
commitment whose answer was lost, and the controller's own rule (one
commitment per space, step 1) has to.

Parking and removal (`/park`, `/remove`) only touch staged handles. Both
statements are restricted to `commitment_root IS NULL`. A handle inside a
local commitment can't be parked or removed.

Local rollback (`/rollback-local`) deletes the last commitment only if its
`commit_txid` is empty. It unstages that commitment's handles, keeping their
parked flags, and deletes the prover job keys.

Broadcast (`POST /spaces/:space/broadcast`) takes only `{"fee_rate": ...}`.
It checks health and that the wallet can still operate the space, and it
refuses if the last commitment already has a `commit_txid`. It then calls the
`spaced` wallet's `wallet_send_request` with a `Commit` request for the root.
That call builds, signs and sends the transaction, with `confirmed_only:
false`. Only afterwards does `subs` store the returned `txid` through
`update_commitment_txid`. A lost response, or a crash between the send and
the store, leaves a transaction that may be on the network while `subs`
records no `txid`.

Commit status (`GET /spaces/:space/commit/status`):
- `none` when there is no commitment or it has no `txid`;
- `pending` when a `txid` is stored but the chain's root differs, which can
  mean in the mempool, dropped or replaced;
- `confirmed` when the chain's root equals the local root, without checking
  the `txid`;
- `finalized` at `d >= 150`, with no `txid` in the answer.

None of these can say whether an expected local commitment exists, or
whether a send with a lost response reached the network.

Health. If the chain carries a commitment root that `subs` doesn't know, every
action is disabled. The message says recovery needs the `.sdb` file and the
certificate used to prove it, and that recovery "is not supported" yet. The
same check uses `FINALITY = 144` to decide whether rollback is still possible.

Callbacks. `/ack` carries `{handle, outcome}` and `/committed` carries
`{root, handles: ["name@space", ...]}`. Neither includes the recipient script.
`/registry/notify` sends `/committed` only when called, and the handler's own
comment says to call it "after a commitment is finalized".

Readback. `GET /spaces/:space/handles?filter=staged|committed|parked` (paged)
and `GET /spaces/:space/handles/:handle` return each handle's
`script_pubkey`, `commitment_root`, `commitment_idx`, `publish_status` and
`parked` flag.

Background. A proving loop always runs. The registry loop runs only when
`registry_auto_sync` is on, which is off by default. Nothing broadcasts in
the background.

Publishing. A manual `/registry/sync` (`sync_once`) pulls, stages and
acknowledges, and publishes nothing. Publishing happens only in the automatic
registry loop or through `/spaces/:space/publish` (`publish_certs`). Both
issue "temp" certificates for every unpublished handle that isn't in the
confirmed on-chain commitment, including staged handles, and "final"
certificates for handles at or below it. Temp certificates published against
a stale tip are reset and republished.

Publish call details at the pinned commit (`routes/commits.rs` and
`publish_certs` in `core/src/app.rs`):
- an empty or missing handle list means "all unpublished", including temp
  certificates for staged handles;
- an explicit list is cut to `PUBLISH_BATCH_SIZE`, 1,000, by `take(limit)`,
  and the rest are silently skipped;
- explicit lists skip the automatic batch resizing;
- a message over the relay size limit isn't sent. The call still succeeds,
  with `handles_published: 0`;
- for an explicit list, `remaining` is the batch length minus the published
  count, so it is 0 after any sent batch, even if handles beyond the cap
  were dropped;
- certificates are rebuilt from the live on-chain tip at call time, and a
  handle becomes "temp" or "final" against that tip.

Publication procedure:
1. Keep, per batch, a journaled set of outstanding handles: members whose
   certificate has been verified at `d >= 150` and whose publication isn't
   yet confirmed.
2. If that set is empty, do nothing. Never call `/publish` with an empty
   list.
3. Split the set into chunks of at most 100 handles (proposal), well under
   the cap. If a call returns `handles_published: 0` for a non-empty chunk,
   halve the chunk and retry. A single handle that can't be sent pauses the
   space and alerts the owner.
4. Immediately before each call, read the live commitment with
   `getcommitment` and check that its root is the batch's root at
   `d >= 150`. If not, don't call. A reorg means waiting until it holds
   again.
5. After each call, read each handle's `publish_status` from
   `/spaces/:space/handles/:handle`. Only "final" counts toward progress. A
   "temp" result means the certificate was built against a different tip, so
   the handle stays outstanding and the owner is alerted.
6. Confirm delivery per handle with a verified lookup through the relay
   network, using the verifying client from the buyer gate. It must return
   a final certificate for the handle with its `script_pubkey`, under the
   space's live commitment at `d >= 150`. That is the batch's root, or a
   later one once the space has moved on, because relays serve certificates
   against the space's current root (R23). The batch's own root must still
   be on chain, which step 4's live check confirms. A relay's `/peek` output
   doesn't count. Only a published handle is
   confirmed, and the live-commitment check of step 4 runs again immediately
   before the confirmation.

HTTP success, `handles_published`, `remaining = 0` and
`publish_status = "final"` are all signals, not proof of delivery. Only step
6 removes a handle from the outstanding set.

The controller never turns on automatic sync. What a temp certificate means
to relays and to Nacho is a maintainer question.

## What this requires

U1, an upstream change to `subs` (required before the operator gate can
pass):
- (a) an idempotent broadcast: record an intent before the wallet send, and on
  any retry look for an existing transaction carrying the root, from the
  wallet, the mempool or the chain, and adopt it instead of sending again;
- (b) a way to attach a known `txid` to the last local commitment, which a
  restore needs when the snapshot predates the broadcast. Without it, a
  later commitment restored without its `txid` blocks every further local
  commit (R17). A candidate patch, checked on regtest, is in
  `regtest/upstream/`: `POST /spaces/:space/commit/txid` attaches the `txid`
  only when the commitment has none, `spaced` is synced, the chain's
  commitment carries its root at height H, and `spaced`'s nums block index
  for H shows that exactly this transaction committed the space to that
  root. Without the block index it refuses. The space's current delegate
  output isn't evidence, because another transaction can move it later in
  the same block (R18, R22);
- (c) preferably, a split into "prepare" (build and sign, store the raw
  transaction and `txid`) and "send", so the exact bytes can be journaled
  before anything escapes. That also makes a commitment that was never seen
  after its send, or was evicted, recoverable from its own bytes (L8).

Until U1 exists, the controller wraps `/broadcast` in an adapter with one
rule: a `/broadcast` call without a recorded answer is an uncertain broadcast.
Rebroadcasting the identical journaled bytes is not a `/broadcast` call and
stays allowed. `subs` itself doesn't follow this rule. After a restore or a
lost answer it holds the local commitment without a `txid`, and its
`/pipeline` offers "Ready to broadcast" for a commitment already on chain
(R13). Only the controller stands in the way of a second send, which is one
more reason `subs` is reachable by the controller alone.

For an uncertain commitment the controller never calls `/broadcast` or
`/rollback-local` again. It reads back the evidence below, pauses the space
and alerts the owner. Resolving it means either adopting the `txid` that the
readback finds into the controller's journal, which needs no change to
`subs` (R14), or safe supersession (see `PAYMENT-SPEC.md`), which is an
on-chain action that needs the owner's decision. Attaching that `txid`
inside `subs`, so that its own status and its next local commit see it,
needs U1(b) or a repair the owner authorizes.

Authoritative readback for an uncertain broadcast, using `spaced` RPC calls
that exist in `spaces` v0.5.0 (`client/src/rpc.rs` at tag
`spaces_client-v0.5.0`):
- the space's commitment state, through `getcommitment(subject, root)`;
- the delegate, through `getdelegation(subject)`, and its current output,
  through `getnumout`. Whether that output is still unspent comes from
  `getnumout` and the operator wallet's `walletlistunspent`;
- the operator wallet's transactions, through `walletlisttransactions` and
  `gettxmeta(txid)`, decoded for a spend of the delegate output and its
  OP_RETURN root.

`spaced` exposes no mempool call, so a mempool lookup goes to the Bitcoin node
directly. With the `yuki` light client there may be no mempool at all, so the
deployment must include a node that can answer it, or accept that this
readback is wallet-and-chain only. The exact argument and return shapes are
checked against the pinned source when the adapter is written.

A transaction found with the batch's root is adopted in the controller's
journal. Finding nothing proves nothing: the transaction may sit in other
nodes' mempools.

U2: membership readback is available over HTTP. No change is needed.

U3: callbacks carry no script, so the registry looks up each handle's script
in its own order and checks it against `HandleInfo.script_pubkey`, and later
against the verified certificate. A mismatch pauses the space.

## Boundaries and writers

The registry owns orders, payments, refunds and eligibility, in SQLite. Its
`/pending` returns exactly the frozen batch's members, and nothing else.

The controller is the only caller of `subs`' write endpoints and of the
`spaced` operator wallet. It holds a single-writer lock in its database.

That lock doesn't stop `subs` itself. `subs` still writes through its proving
loop and through anything that reaches its UI or API, and `spaced` writes its
wallet. So:
- `subs` and `spaced` listen only on the host's private interface, never
  behind Caddy;
- registry automatic sync stays off;
- snapshots stop `subs` first (see below).

## Batch identity and states

A batch record is created before `subs` is asked to do anything:
- `batch_id`, random and never reused;
- `space` and `prior_root`;
- `members`, the sorted `(handle, script_pubkey, order_id)` list;
- `digest`, SHA-256 over the canonical encoding of the above;
- `supersedes`, the batch this one replaces after a rebuild;
- later, the new root, the proof result, the checkpoint and journal
  acknowledgments, the broadcast intent and answer, the `txid`, the mined
  height and the finality height.

States: `frozen`, `staged` (readback matches), `committed_local` (readback
matches), `proved`, `verified`, `checkpointed`, `issuing` (intent journaled
off-host), then `broadcast` (`txid` known) or `broadcast_uncertain`, then
`mined`, `final` (`d >= 150`) and `fulfilled` (certificates verified). Side
states: `rebuilt` (replaced before `issuing`), `superseded` (safe supersession
proven), `paused`.

Every transition is one database transaction, and a state is entered only
after its evidence is stored.

## One cycle

The rule throughout is to journal the intent before any external effect, read
back after it, and never repeat an effect whose outcome is unknown.

1. Freeze. Only when no other batch of the space is open, from `frozen` up
   to `final`: one commitment per space is in flight, which `subs` also
   requires for its next local commit. Choose the members (batch entry in `PAYMENT-SPEC.md`), compute the
   digest and store the batch.
2. Stage. Call `/registry/sync`. Read back `filter=staged`. Park every
   unparked staged handle that isn't a member, which works because they are
   still staged. Read back again. The batch becomes `staged` when the
   unparked staged set equals the members, with each script equal to the
   member's.
3. Local commit. Journal the intent, call `/spaces/:space/commit`, and record
   the new root. Read back each member: `commitment_root` must equal the new
   root. Read back `filter=staged` to check that no member is still staged. A
   mismatch is repaired by `/rollback-local`, which is safe because no
   broadcast has been attempted, and the cycle returns to step 2.
4. Prove. Submit each proof through `POST /spaces/:space/proving/push`:
   a step proof, then a fold for a commitment after the second. The
   background proving loop only polls a job that is already in flight, and
   never starts one (R12). Poll `/pipeline` until proving is complete. An
   initial commitment needs no proof. Proving has no on-chain effect.
5. Verify the proof locally with the pinned verifier against the prior and new
   roots. A failure pauses the space; it is never retried into a broadcast.
6. Check. Run the binding pre-broadcast check from `PAYMENT-SPEC.md`. If a
   member fails:
   1. call `/rollback-local`, so the members are staged again;
   2. park the failing members;
   3. read back;
   4. commit locally again with readback;
   5. re-prove and verify;
   6. check again.

   The batch becomes `rebuilt`, and the new one has `supersedes` set. After
   three rebuilds in a row, wait one block and alert the owner.
7. Checkpoint. Take the coordinated snapshot (below) and confirm every object
   off-host.
8. Issue. Read depths from the controller's own node. Then, in one serialized
   database transaction, repeat the database side of the binding check, mark
   every member `issuing`, and record the broadcast intent: `batch_id`, root,
   prior root, the delegate output read from `spaced`, and the fee rate. This
   is the transaction that cancellation serializes against. Append the intent
   to the off-host journal together with the members' `issuing` marks, and
   confirm both. Immediately before the call, check that both are confirmed
   for exactly this root and delegate output. Only then call `/broadcast`
   once. If either is unconfirmed, nothing is sent and the batch stays
   `issuing` until a resume finds both confirmed. A resume is refused once
   the call has been attempted. Before the first transmission, a resume
   repeats the database side of the binding check with fresh depths and
   eligibility, and reads the delegate output again. If a member fails, the
   batch is journaled as `rebuilt` before its members return to paid, and
   the cycle continues from step 6 without the failing member. Otherwise the
   intent is journaled again, and the send goes ahead as above.
9. Record. A returned `txid` is journaled and the batch becomes `broadcast`.
   No answer makes it `broadcast_uncertain`, which follows the adapter rule
   above. The signed transaction is read by its `txid` from the controller's
   node, or from the operator wallet, and journaled as soon as it is seen.
   With U1(c) it is journaled before the send.
10. Watch until `d >= 150`. Use `/commit/status` together with the
    controller's own lookup of the `txid` and the root, because `confirmed`
    there doesn't check the `txid`. A commitment that loses depth stays
    non-cancellable unless it is safely superseded. A final commitment that
    falls below `d >= 150`, or off the best chain, loses finality: the batch
    returns to `mined` or `broadcast`, its ready members return to
    `issuing`, publication and delivery wait, and the owner is alerted. A
    commitment in no mempool and off the best chain is rebroadcast from its
    journaled signed bytes, after the journal check of step 8. That is never
    a `/broadcast` call. Without journaled bytes, recovery pauses and alerts
    the owner.
11. Final. Call `/registry/notify` and verify each member's certificate. A
    verified member becomes "ready", and its certificate is shown to the
    buyer. Then publish through the procedure above. A member becomes
    fulfilled only when its delivery is confirmed individually. Duplicate `/committed` callbacks are no-ops.

The registry's `/ack` and `/committed` handlers are idempotent and keyed by
handle, the only key in those payloads.

## Journal, snapshots and confirmation

The journal is an append-only log of every intent and outcome, kept off-host:
- local commit intents and roots;
- broadcast intents and answers;
- refund reservations, built transactions, exported PSBTs and broadcast
  answers;
- cancellations;
- batch state changes.

Nothing that can escape the host is sent until its journal entry is
confirmed off-host. That covers a broadcast, a resumed broadcast, a refund
broadcast or rebroadcast, and a PSBT export. Each path checks its entry
immediately before the call, not after it. For a commitment the entry is the
broadcast intent together with the members' `issuing` marks, so a lagging
registry journal blocks the broadcast too. The journal is what covers the
time between snapshots.

A coordinated snapshot:
1. take the controller lock;
2. stop `subs` and wait until its process has exited, which stops the
   proving loop;
3. copy the `subs` data directory, including its SQLite database and the
   space database (`.sdb`);
4. back up the registry database through SQLite's backup API;
5. record the journal position;
6. start `subs` again.

The `spaced` wallet's key material is backed up once at onboarding and again
whenever it changes. Its transaction history is rebuilt by rescanning, since
every transaction the store cares about is in the journal.

Confirmation is per object. Each uploaded object is fetched back and its
SHA-256 compared, or checked against the provider's stored SHA-256 checksum.
A manifest read-back alone proves neither that the payloads exist nor that
they restore. Restore correctness is proven separately: by the operator gate,
and by a scheduled restore drill onto a scratch host (weekly, proposal).

Recovery uses the latest snapshot plus the journal since it, reconciled
against the chain. Chain evidence alone isn't enough: it can't reconstruct
staged membership, reservations, exported PSBTs or the tree.

The off-host store, the encryption key and how the operator wallet is
exported all involve credentials, so the owner decides them.

## Restore and reconciliation

1. Restore the snapshot onto a fresh host. Replay the journal into the
   registry and controller databases.
2. For each space, compare the journal with the restored `subs` state:
   - a local commitment in the journal but absent from `subs` means the
     snapshot predates it. If no broadcast intent follows, redo it from
     step 2 of the cycle;
   - a broadcast intent after the snapshot means `subs` has the local
     commitment, from the snapshot, with no `txid`. Read back the chain,
     the node's mempool and the operator wallet. If the root is on chain or
     a spend of the delegate output carries it, adopt the `txid` in the
     controller's journal. That needs no change to `subs` (R14). Telling
     `subs` the `txid`, so its own status and its next local commit see it,
     needs U1(b). Otherwise the batch is `broadcast_uncertain`;
   - a batch with a journaled intent, a `txid` or a later state has every
     member marked `issuing` in the registry again before any cancellation
     is accepted, even where the registry's journal lagged;
   - a batch whose members are `issuing` but whose intent was never
     confirmed was never sent, because the send checks both. It is resumed
     from step 8, and its intent is journaled before the call;
   - a batch not yet checkpointed whose members are missing from the
     restored registry is rebuilt;
   - an order that the registry shows as `issuing` or ready, but that is in
     no live batch of the controller's journal, was never sent or was
     superseded, and returns to paid. A fulfilled one keeps its status and
     gets a recovery incident;
   - `/rollback-local` is only for a batch before `issuing`;
   - never call `/broadcast` or `/rollback-local` for a commitment with a
     journaled broadcast intent.
3. For each refund family, look up every member before doing anything. Keep
   every reservation.
4. Start the controller only when every batch and refund family is
   reconciled or explicitly paused.

## Certificate verification

For each member of a batch at `d >= 150`, fetch the certificate from `subs`
(`/certs/:handle`) and verify it with the pinned `libveritas`:
- it names the expected handle and the order's `script_pubkey`;
- it proves inclusion in the batch's root and absence from earlier roots;
- that root is the one in the mined transaction recorded for the batch. A
  certificate built after a later commitment proves inclusion in the
  space's live root instead, and then that root must be the space's
  current on-chain commitment (R23).

A member's certificate must also verify as sovereign. libveritas judges
that from the newest root anchor it is given, and `spaced` computes one every
36 blocks, so a certificate can verify as pending for up to 35 blocks after
`d >= 150` (regtest R11). Pending is waiting for anchor coverage. The member
stays `issuing`, nothing is paused, and verification runs again once an
anchor is 144 blocks past the commitment. Only then is the member "ready".

The committed root is checked on the space's zone of the verified message,
together with its height, against the batch's root and mined height. The
handle's zone carries the `script_pubkey` and sovereignty, not the root
(regtest R9).

A relay's `/peek` output is never evidence. A failed verification pauses the
space and alerts the owner.

## Operator gate rehearsal

On a throwaway space, with U1 in place:
1. Run one batch to `fulfilled`. Stop a second batch at each of
   `committed_local`, `checkpointed`, `issuing` with the broadcast answer
   withheld, and `broadcast`. Open one refund family with an exported PSBT and
   one with a broadcast hot-wallet refund.
2. Destroy the host. Restore the snapshot and journal onto a fresh host.
3. Reconcile as above. No name may be issued twice, no refund may pay twice,
   no reservation may disappear, and the restored tree's root must match the
   chain.
4. Issue another test batch to `fulfilled` and verify its certificates.

## Still to confirm before building

Checked on 2026-11-06, and recorded above:
- the `spaced` v0.5.0 calls for the commitment, the delegate output and the
  wallet's transactions;
- the protocol finality rule, `height > block_height + 144`;
- what sync and publishing emit.

Checked on regtest on 2026-11-07 (`regtest/FINDINGS.md`): `subs` runs on
regtest against a separately started `spaced` (R1), the `spaced` call
shapes the adapter needs (R3), and a full Bitcoin Core node can answer the
mempool readback (R4).

Still open:
- whether a deployment on `yuki` can answer mempool lookups;
- whether the maintainers would accept U1, or prefer another shape;
- what temp certificates mean to relays and to Nacho;
- CPU proving time for later commitments of 50 names. On regtest, commitments
  of 1 and 2 names took 35 to 141 s, step and fold together, varying between
  runs;
- the operator-side effect of R16 after a later commitment without a
  `txid`, which was read from the source but not run.

## Out of scope for this draft

A separate signer (open decision 2), Lightning, and any mainnet execution.
Running anything on mainnet needs a concrete plan and the owner's explicit
authorization.
