# TypeScript application and controller reconciliation

This extends `APPLICATION-RESTORE.md` with an offline completion command for
known issuance histories. The independent lifecycle model is
`ts/model/recovery.ts`. Python's frozen store behavior is unchanged; its
controller remains the issuance adapter. `NETWORK-READINESS.md` now binds their explicit parent network, including the
main/mainnet mapping, without changing the supported history or no-send scope.

```text
node ts/src/main.ts reconcile <runtime-config.json> <runner-config.json>
```

Stop and fence the old installation first. Restore the application journal
into a fresh path, using the same financial configuration, then reconcile.
The two configurations must identify the same store database, journal and
Core endpoint/cookie. The parent holds exclusive store ownership throughout;
the shipped Python subprocess takes exclusive controller ownership. It uses
an offline inventory on stdin instead of an HTTP recovery listener. No buyer
or operator listener is opened. Recovery never allocates an address, signs,
sends, releases an entry, rolls back a tree or generates a new one-use arm.

## Evidence and supported histories

First normalize recovery and reread payment and every signed refund member
through the read-only adapters. Require live acknowledgment of the complete
store journal prefix. The inventory binds the store UUID, restore source
sequence, current sequence and coherent Core tip. It includes all orders'
identities, handles, recipients and states, every entry's immutable binding,
arm/closure/supersession and known transaction, and every listed space. It
contains no bearer links, cookies, refund destinations or signed bytes.

When the controller database is missing journaled batches, restore its
history and the coordinated subs snapshot using the existing resumable
restore procedure. Before copying anything, validate every manifest file,
the exact file set, absence of symlinks, the snapshot store UUID and journal
positions within the live histories. Subs must be stopped throughout the
copy. Its restart belongs to this procedure, with no competing supervisor.

Each active store entry must have exactly one controller batch with the
same root, space and ordered members. An armed entry requires a known,
consistent transaction identity. An empty mempool or an unset local attempted
flag cannot establish that an armed entry was never sent. Missing bindings,
unbound issuing/ready/fulfilled orders, attempted open entries and unknown
armed transaction identities refuse completion, retaining quarantine.
Closed entries stay closed; a currently valid recorded supersession stays
superseded. No recovery read grants a send permission.

The operator wallet must be scanned to the current tip and know each active
original/conflict transaction. Inspect its complete paginated history, up to
100,000 transactions; a larger history requires a reviewed extension, not
truncation. For a known active original, require actual Core mempool or
active-chain evidence, a fresh bound commitment observation and Spaces root
acceptance if mined. The controller preserves intent/attempted history.
Every listed space must have the same subs/chain root or exactly one known
pending local commitment ahead of the chain. Check the local member
recipients. A restored mined tree missing its known transaction needs the
U1(b) attach route: journal that attachment before applying it and reread it.
An unavailable route refuses completion. This metadata attachment broadcasts
nothing. Missing unsent tree data and unfamiliar chain/tree states remain
manual recovery; the command does not reconstruct or discard them.

The controller journals a version-1 statement covering exactly the submitted
entries and spaces. Its SHA-256 uses recursively sorted object keys and
compact UTF-8 JSON. The digest detects inconsistent evidence; it is not a
signature against a compromised host or journal. The store checks exact
fields, inventory identity, coverage, immutable bindings and permitted modes.
It independently rereads the operator wallet, exact Core transaction/input/
root and active block/depth, Spaces commitment height, latest space roots
and subs pipelines. The controller owns the per-member subs binding check;
the store's root read alone does not independently verify every tree member.
Core and Spaces must still be at the inventory tip after these reads.

## Durable completion and crashes

Confirm the controller proof is the latest record of a contiguous live
journal, with its exact digest, and fsync the file and directory. A journal
outage, newer head or missing/changed proof refuses. Refresh store chain and
accounting again; if the sanitized inventory or tip changed, retry from fresh
evidence. Time advancing alone does not invalidate unchanged facts.

Persist fresh commitment observations and a version-2 application recovery
record containing `required: false`, source sequence, proof hash, controller
sequence and tip height/hash. Sales stay globally paused. First fulfillment,
reserves, cancellations and refund history remain; cached certificates stay
invalid until a new verification. The completion record does not resolve a
delivery incident by itself.

Confirm the controller before publication and again after the complete store
journal prefix is acknowledged. Only then clear the local restore latch.
Normal startup requires both that latch and the journaled recovery requirement
to be clear. Death after durable completion but before local clearing still
refuses startup; another offline reconciliation refreshes the facts and
completes it. A new journal-only restore always re-quarantines a previously
completed installation. Repeating reconcile after full completion refuses
because no local restore is pending; inspect normal status instead.

The completion receipt reports ready, acknowledged, sales_paused, waiting,
proof_hash and controller_sequence. Exit 2 and ready false mean the store
journal has not acknowledged completion. An acknowledged successful receipt
allows paused normal startup, not automatic sales admission. The normal
runner only adopts completion bound to its own controller journal and store
identity, and still requires its ordinary recovery-readiness checks.

## Qualification scope

Default tests use real processes, SQLite/journals and recording chain peers.
The separate Spaces-stack scenario restores application/controller/subs paths
after a fulfilled sale and settled cancellation refund, reverifies the
original certificate and issues again. Core and both wallets stay live in
that scenario. Wallet onboarding-backup restore and whole-host loss remain
separate acceptance work. No browser, buyer-client or public-network gate is
established by this command. Paid sales remain closed.
`HOST-RECOVERY.md` extends the qualification procedure to fresh seller-node
and wallet paths, with explicit replacement-credential configuration before
admission. It does not enlarge the supported uncertain-send histories.

## Cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O88 | complete known bound histories | reconcile with coherent chain and live journals | permit paused startup; preserve arms, financial obligations and first delivery; require fresh certificates |
| O89 | missing, duplicate, foreign or changed statement bindings | validate completion | refuse with issuance ownership and quarantine retained |
| O90 | unknown evidence or either journal unavailable | complete, fail and retry | never clear local startup latch prematurely; retry from fresh acknowledged evidence |
| O91 | an already completed installation's journal | restore into another fresh path | re-quarantine and pause; old completion cannot authorize startup |
| O92 | chain or inventory changes during controller inspection | reread before publication | require a fresh proof, without clearing recovery |
| O93 | shipped offline CLI and runner configuration | reconcile then start normally | one controller proof, paused startup, no listener during recovery or wallet mutation |
| O94 | completion journaled but local latch still set | kill process then retry | normal startup refuses; fresh reconciliation clears the latch without a duplicate address or send |
| O95 | changed Core transaction, stale/missing wallet history or Spaces/subs mismatch | independently verify evidence | refuse all mismatches without wallet mutation |
| O96 | controller proof followed by a newer write, truncation, corruption or outage | confirm current journal | exact latest contiguous proof and digest required before completion |
| A51 | matching armed store/controller history | reconcile known original transaction | retain intent/attempted state and fresh observation; no send or new permission |
| A52 | unknown or conflicting armed identity, or controller journal outage | reconcile | refuse, retaining entry ownership |
| A53 | missing entry/batch bindings or an attempted open entry | reconcile | refuse rather than declare an uncertain send unsent |
| A54 | unavailable/stale wallet, mismatched root/recipient, unknown RPC or missing attachment capability | build controller proof | refuse completion; no rollback or release |
| A55 | normal runner with a completion marker | adopt readiness | require its own acknowledged journal proof, matching store UUID/source and ordinary readiness |
| A56 | coordinated recovery snapshot | validate before copy | check exact bytes, paths, store identity and journal bounds; refuse a forged or incomplete set |
| A57 | fresh or concurrently rewritten Spaces root-anchor file | request root anchors | retry only known open/read file errors within the finite limit; unrelated errors and exhaustion refuse without releasing ownership |
