# Regtest run report

Every result below is labelled "regtest": the pinned bitcoind, spaced and
subs on a local regtest network, driven by the harness in `regtest/`. None
of it is model, integration, mainnet or buyer-acceptance evidence. The
"model" column is what the reference model expects for the same events.

Verdict: fail (1 required steps disagree).

- label: regtest
- run: continued-pinned-20261107T085046Z-cc9a7a
- scenarios: ['first_purchase', 'second_commitment', 'restore', 'continued_operation']
- isolation: unprivileged user and network namespace (unshare -rn), loopback only
- subs_binary: .cache/bin/subs
- pins: {'SUBS_REPO': 'https://github.com/spacesprotocol/subs', 'SUBS_COMMIT': '4dcc9237af3a807497d4b1532729842ee5dcdb68', 'SPACES_REPO': 'https://github.com/spacesprotocol/spaces', 'SPACES_TAG': 'spaces_client-v0.5.0', 'SPACES_COMMIT': '77653f01889ddc86337e4b27d7d3ae4fc334a117', 'BITCOIN_VERSION': '26.0', 'BITCOIN_TARBALL': 'bitcoin-26.0-x86_64-linux-gnu.tar.gz', 'BITCOIN_URL': 'https://bitcoincore.org/bin/bitcoin-core-26.0/bitcoin-26.0-x86_64-linux-gnu.tar.gz', 'BITCOIN_SHA256': '23e5ab226d9e01ffaadef5ffabe8868d0db23db952b90b0593652993680bb8ab'}
- completed: ['first_purchase', 'second_commitment', 'restore', 'continued_operation']
- anchor_read_retries: 0


## 1. first purchase

| label | case | kind | step | regtest result | model expects | agree |
| --- | --- | --- | --- | --- | --- | --- |
| regtest |  | informational | recipient request for one@test10000 | {"oid": "o1", "script_pubkey": "51209ab0aab2e4d7ad2b68c33857253e73625922974c977b8afcca8b6820dabc0747"} |  |  |
| regtest |  | required | fixed-price quote for o1 | {"quoted": true, "status": "quoted", "price_sats": 10000, "address": "bcrt1pkn7r3jaak5f6em27yvlff34fk4ensg0c82etjhal6yzg8c8ppxuqma5594"} | {"quoted": true, "status": "quoted", "price": 10000} | yes |
| regtest | Q1 | required | second quote for the held name | {"quoted": false, "why": "taken for now"} | {"quoted": false, "why": "taken for now"} | yes |
| regtest |  | required | payment at 1 conf | {"o1": "quoted"} | {"o1": "quoted"} | yes |
| regtest | P1 | required | payment at 3 conf converts the hold | {"o1": "converted"} | {"o1": "converted"} | yes |
| regtest |  | required | freeze b1 | {"members": ["o1"], "state": "frozen"} | {"ok": true, "members": ["o1"], "state": "frozen", "refusal": null} | yes |
| regtest |  | informational | stage b1 with readback | {"staged": {"one": "51209ab0aab2e4d7ad2b68c33857253e73625922974c977b8afcca8b6820dabc0747"}, "parked": [], "sync": {"success": true, "pulled": 1, "staged": 1, "errors": []}} |  |  |
| regtest |  | required | local commit b1 with readback | {"state": "committed_local", "root": "56a9c52f4b97cc66b9ac800ee8436ea1e69aa141943dd9d9c65286141eb4bcef", "prev_root": null, "is_initial": true, "handles": 1, "members_on_root": 1} | {"state": "committed_local", "members": ["o1"]} | yes |
| regtest |  | required | prove b1 | {"seconds": 0.0, "proving": "skipped", "proof_total": null, "pushes": []} | {"state": "proved"} | yes |
| regtest |  | required | checkpoint b1 (coordinated snapshot) | {"dir": "regtest/.run/continued-pinned-20261107T085046Z-cc9a7a/offhost/snapshots/001-b1", "objects": 8, "store_journal": 5, "controller_journal": 5} | {"state": "checkpointed"} | yes |
| regtest | B3 | required | binding check passes; members issuing | {"o1": "issuing"} | {"o1": "issuing"} | yes |
| regtest | B3 | required | b1 broadcast | {"state": "broadcast", "txid": "faf69c94ed75ed8ddd36c12b78373dcf5d5b5ccd1cd1aa41d36146643004678a"} | {"state": "broadcast"} | yes |
| regtest | X3 | required | cancellation after issuing | {"cancelled": false, "why": "not cancellable once issuing"} | {"cancelled": false, "why": "not cancellable once issuing"} | yes |
| regtest |  | required | b1 mined at d = 0 | {"state": "mined", "position": [3454, 0]} | {"state": "mined"} | yes |
| regtest |  | required | b1 at d = 149 | {"state": "mined"} | {"state": "mined"} | yes |
| regtest |  | required | b1 at d = 150 | {"state": "final", "subs_commit_status": {"status": "finalized", "txid": null, "block_height": 3454, "confirmations": null}} | {"state": "final"} | yes |
| regtest | L6 | required | certificate status for b1 at d = 150 | {"status": "verified", "newest_anchor": 3600, "mined_height": 3454} | {"status": "verified"} | yes |
| regtest |  | required | certificates for b1 verified with libveritas | {"notify": true, "results": {"o1": {"ok": true, "checks": {"verified": true, "handle": true, "script_pubkey": true, "root": true, "root_height": true, "sovereign": true}, "error": null, "zone": {"anchor": 3600, "canon... |  | yes |
| regtest |  | required | b1 members after verification | {"o1": "ready"} | {"o1": "ready"} | yes |
| regtest | L1 | required | b1 after a 151-block reorg drops the commitment | {"state": "broadcast", "in_mempool": false, "getcommitment": null, "subs_commit_status": {"status": "pending", "txid": "faf69c94ed75ed8ddd36c12b78373dcf5d5b5ccd1cd1aa41d36146643004678a", "block_height": null, "confirm... | {"state": "broadcast"} | yes |
| regtest | L1 | required | members while finality is lost | {"o1": "issuing"} | {"o1": "issuing"} | yes |
| regtest | L1 | required | cancellation while finality is lost | {"cancelled": false, "why": "not cancellable once issuing"} | {"cancelled": false, "why": "not cancellable once issuing"} | yes |
| regtest | L1 | required | certificate verification while not final | {"allowed": false, "why": "not final"} | {"allowed": false, "status": "not_final"} | yes |
| regtest | L7 | informational | commitment in the node's mempool after the reorg | {"in_mempool": false, "testmempoolaccept": true} |  |  |
| regtest | L7 | required | /broadcast again after the reorg | {"allowed": false, "why": "never repeat a broadcast whose outcome is unknown"} | {"allowed": false, "why": "never repeat a broadcast whose outcome is unknown"} | yes |
| regtest | L7 | required | rebroadcast the identical journaled bytes | {"sent": true, "result": "faf69c94ed75ed8ddd36c12b78373dcf5d5b5ccd1cd1aa41d36146643004678a", "in_mempool": true, "raw_journaled": true} | {"sent": true, "why": ""} | yes |
| regtest | L7 | required | a second rebroadcast while it is in the mempool | {"sent": false, "why": "the commitment is still on the chain or in the mempool"} | {"sent": false, "why": "the commitment is still on the chain or in the mempool"} | yes |
| regtest | L1 | required | b1 mined again at d = 0 | {"state": "mined", "position": [3606, 0]} | {"state": "mined"} | yes |
| regtest | L2 | required | b1 back at d >= 150 | {"state": "final", "subs_commit_status": {"status": "finalized", "txid": null, "block_height": 3606, "confirmations": null}} | {"state": "final"} | yes |
| regtest | L6 | required | certificate status for b1 at d = 150 | {"status": "awaiting_anchor", "newest_anchor": 3744, "mined_height": 3606} | {"status": "awaiting_anchor"} | yes |
| regtest | L6 | required | verification refused while awaiting the anchor | {"verified": false, "why": "no anchor covers the commitment yet (newest 3744, mined 3606)"} | {"verified": false, "status": "awaiting_anchor"} | yes |
| regtest | L6 | required | b1 members while awaiting the anchor | {"o1": "issuing"} | {"o1": "issuing"} | yes |
| regtest | L6 | required | certificate status after mining 24 blocks to the anchor at 3780 | {"status": "verified", "seconds_waited_for_anchor_after_tip": 0.0} | {"status": "verified"} | yes |
| regtest |  | required | certificates for b1 verified with libveritas | {"notify": true, "results": {"o1": {"ok": true, "checks": {"verified": true, "handle": true, "script_pubkey": true, "root": true, "root_height": true, "sovereign": true}, "error": null, "zone": {"anchor": 3780, "canon... |  | yes |
| regtest |  | required | b1 members after verification | {"o1": "ready"} | {"o1": "ready"} | yes |

## 2. second commitment with a proof

| label | case | kind | step | regtest result | model expects | agree |
| --- | --- | --- | --- | --- | --- | --- |
| regtest |  | informational | recipient request for two@test10000 | {"oid": "o3", "script_pubkey": "51207cd60a798c99a87151bb7fbad6e48a4163400e4cc776d39955b6cfed4733c820"} |  |  |
| regtest |  | required | fixed-price quote for o3 | {"quoted": true, "status": "quoted", "price_sats": 10000, "address": "bcrt1pw09zs4zt7udxt7vtp7xmsrjf9gaecyt6tpkautqkm0dw2dukm50qcnhq5z"} | {"quoted": true, "status": "quoted", "price": 10000} | yes |
| regtest |  | informational | recipient request for three@test10000 | {"oid": "o4", "script_pubkey": "51205189b2d8698dba8fad79f4ff00d6b15dea4a9bcbd8dcf7c0bc59c363387c9e73"} |  |  |
| regtest |  | required | fixed-price quote for o4 | {"quoted": true, "status": "quoted", "price_sats": 10000, "address": "bcrt1pgkzmlpvhn0myqt30437f3ltqljerf0v9m47fkagnx338uwm3qqdss5e77z"} | {"quoted": true, "status": "quoted", "price": 10000} | yes |
| regtest |  | informational | recipient request for four@test10000 | {"oid": "o5", "script_pubkey": "5120cbc9e1486124a4fbe64d77cb3adf049a9fd626c7cdbb53a3bd5bfc701255993e"} |  |  |
| regtest |  | required | fixed-price quote for o5 | {"quoted": true, "status": "quoted", "price_sats": 10000, "address": "bcrt1p20vxm4hfspv7v3sn3zjq8v49lxg535q76keyvxwadj5z0nmvgu9qgamcwa"} | {"quoted": true, "status": "quoted", "price": 10000} | yes |
| regtest | P1 | required | three payments at 3 conf | {"o3": "converted", "o4": "converted", "o5": "converted"} | {"o3": "converted", "o4": "converted", "o5": "converted"} | yes |
| regtest |  | required | freeze b2 | {"members": ["o3", "o4"], "state": "frozen"} | {"ok": true, "members": ["o3", "o4"], "state": "frozen", "refusal": null} | yes |
| regtest |  | informational | stage b2 with readback | {"staged": {"two": "51207cd60a798c99a87151bb7fbad6e48a4163400e4cc776d39955b6cfed4733c820", "three": "51205189b2d8698dba8fad79f4ff00d6b15dea4a9bcbd8dcf7c0bc59c363387c9e73"}, "parked": [], "sync": {"success": true, "pul... |  |  |
| regtest |  | required | local commit b2 with readback | {"state": "committed_local", "root": "9c868ef7195bfaa0c9f94a0cec81af11562889b28fbb4e45d5a83cd79d6dab43", "prev_root": "56a9c52f4b97cc66b9ac800ee8436ea1e69aa141943dd9d9c65286141eb4bcef", "is_initial": false, "handles":... | {"state": "committed_local", "members": ["o3", "o4"]} | yes |
| regtest |  | required | prove b2 | {"seconds": 65.2, "proving": "complete", "proof_total": null, "pushes": [{"t": 0.0, "proof_index": 1, "job_id": "849036ff-da11-4d47-9344-799b99586230", "message": "proving request submitted to prover"}]} | {"state": "proved"} | yes |
| regtest |  | required | checkpoint b2 (coordinated snapshot) | {"dir": "regtest/.run/continued-pinned-20261107T085046Z-cc9a7a/offhost/snapshots/002-b2", "objects": 9, "store_journal": 21, "controller_journal": 22} | {"state": "checkpointed"} | yes |
| regtest | B6 | required | freeze a second batch while one is open | {"frozen": false, "why": "another batch is open (b2); one commitment per space"} | {"frozen": false, "why": "another batch is open; one commitment per space"} | yes |
| regtest | J3 | required | issue with the store journal down | {"sent": false, "why": "order locks or broadcast intent not acknowledged off-host; not sent"} | {"sent": false, "why": "order locks or broadcast intent not acknowledged off-host; not sent"} | yes |
| regtest | J3 | required | b2 waits in issuing | {"state": "issuing", "mempool_spends": null} | {"state": "issuing"} | yes |
| regtest | J3 | required | members while the journal is down | {"o3": "issuing", "o4": "issuing"} | {"o3": "issuing", "o4": "issuing"} | yes |
| regtest | J3 | required | resume while the journal is still down | {"sent": false, "why": "order locks or broadcast intent not acknowledged off-host; not sent"} | {"sent": false, "why": "order locks or broadcast intent not acknowledged off-host; not sent"} | yes |
| regtest | J3 | required | resume after both journals acknowledge | {"sent": true, "txid": "f999bbb3097f52faf330e4aae3d31eddf0188714d4b43a332934302764f17cfe"} | {"sent": true} | yes |
| regtest | J3 | required | b2 broadcast once | {"state": "broadcast", "wallet_spends_of_delegate": [{"txid": "f999bbb3097f52faf330e4aae3d31eddf0188714d4b43a332934302764f17cfe", "block_height": null, "root_seen": true, "events": [{"type": "commit_root", "space": "@... | {"state": "broadcast"} | yes |
| regtest |  | required | b2 mined at d = 0 | {"state": "mined", "position": [3784, 0]} | {"state": "mined"} | yes |
| regtest |  | required | b2 at d = 149 | {"state": "mined"} | {"state": "mined"} | yes |
| regtest |  | required | b2 at d = 150 | {"state": "final", "subs_commit_status": {"status": "finalized", "txid": null, "block_height": 3784, "confirmations": null}} | {"state": "final"} | yes |
| regtest | L6 | required | certificate status for b2 at d = 150 | {"status": "awaiting_anchor", "newest_anchor": 3924, "mined_height": 3784} | {"status": "awaiting_anchor"} | yes |
| regtest | L6 | required | verification refused while awaiting the anchor | {"verified": false, "why": "no anchor covers the commitment yet (newest 3924, mined 3784)"} | {"verified": false, "status": "awaiting_anchor"} | yes |
| regtest | L6 | required | b2 members while awaiting the anchor | {"o3": "issuing", "o4": "issuing"} | {"o3": "issuing", "o4": "issuing"} | yes |
| regtest | L6 | required | certificate status after mining 26 blocks to the anchor at 3960 | {"status": "verified", "seconds_waited_for_anchor_after_tip": 0.5} | {"status": "verified"} | yes |
| regtest |  | required | certificates for b2 verified with libveritas | {"notify": true, "results": {"o3": {"ok": true, "checks": {"verified": true, "handle": true, "script_pubkey": true, "root": true, "root_height": true, "sovereign": true}, "error": null, "zone": {"anchor": 3960, "canon... |  | yes |
| regtest |  | required | b2 members after verification | {"o3": "ready", "o4": "ready"} | {"o3": "ready", "o4": "ready"} | yes |

## 3. host loss and restore

| label | case | kind | step | regtest result | model expects | agree |
| --- | --- | --- | --- | --- | --- | --- |
| regtest |  | required | freeze b3 | {"members": ["o5"], "state": "frozen"} | {"ok": true, "members": ["o5"], "state": "frozen", "refusal": null} | yes |
| regtest |  | informational | stage b3 with readback | {"staged": {"four": "5120cbc9e1486124a4fbe64d77cb3adf049a9fd626c7cdbb53a3bd5bfc701255993e"}, "parked": [], "sync": {"success": true, "pulled": 1, "staged": 1, "errors": []}} |  |  |
| regtest |  | required | local commit b3 with readback | {"state": "committed_local", "root": "aad8458042062c16af3230b59694bd41e264fa13ec9ecc834107fad96e7bc204", "prev_root": "9c868ef7195bfaa0c9f94a0cec81af11562889b28fbb4e45d5a83cd79d6dab43", "is_initial": false, "handles":... | {"state": "committed_local", "members": ["o5"]} | yes |
| regtest |  | required | prove b3 | {"seconds": 180.7, "proving": "complete", "proof_total": null, "pushes": [{"t": 0.0, "proof_index": 1, "job_id": "b1795b27-7050-41c0-bd7d-84450700a19b", "message": "proving request submitted to prover"}, {"t": 60.3, "... | {"state": "proved"} | yes |
| regtest |  | required | checkpoint b3 (coordinated snapshot) | {"dir": "regtest/.run/continued-pinned-20261107T085046Z-cc9a7a/offhost/snapshots/003-b3", "objects": 10, "store_journal": 25, "controller_journal": 38} | {"state": "checkpointed"} | yes |
| regtest | B3 | required | b3 broadcast | {"state": "broadcast", "txid": "f84b64944c9a71122a9048d209cd279ea3d0efed449267b851cb6fb0cb2948e7"} | {"state": "broadcast"} | yes |
| regtest |  | required | b3 mined before the host is lost | {"state": "mined"} | {"state": "mined"} | yes |
| regtest |  | informational | host lost | {"kept": ["offhost journals", "snapshots", "bitcoind", "spaced"], "snapshot": "003-b3"} |  |  |
| regtest | J4 | informational | reconcile the restored snapshot against both journals | {"log": []} |  |  |
| regtest |  | required | b3 after restore | {"state": "mined"} | {"state": "mined"} | yes |
| regtest | J4 | required | members after restore | {"o5": "issuing"} | {"o5": "issuing"} | yes |
| regtest | J4 | required | cancellation after restore | {"cancelled": false, "why": "not cancellable once issuing"} | {"cancelled": false, "why": "not cancellable once issuing"} | yes |
| regtest |  | required | restored subs against the chain | {"subs_root": "aad8458042062c16af3230b59694bd41e264fa13ec9ecc834107fad96e7bc204", "subs_txid": null, "chain_root": "aad8458042062c16af3230b59694bd41e264fa13ec9ecc834107fad96e7bc204", "commit_status": {"status": "none"... | {"root_matches_chain": true} | yes |
| regtest |  | required | b3 mined at d = 0 | {"state": "mined", "position": [3961, 1]} | {"state": "mined"} | yes |
| regtest |  | required | b3 at d = 149 | {"state": "final"} | {"state": "final"} | yes |
| regtest |  | required | b3 at d = 150 | {"state": "final", "subs_commit_status": {"status": "none", "txid": null, "block_height": null, "confirmations": null}} | {"state": "final"} | yes |
| regtest | L6 | required | certificate status for b3 at d = 151 | {"status": "awaiting_anchor", "newest_anchor": 4104, "mined_height": 3961} | {"status": "awaiting_anchor"} | yes |
| regtest | L6 | required | verification refused while awaiting the anchor | {"verified": false, "why": "no anchor covers the commitment yet (newest 4104, mined 3961)"} | {"verified": false, "status": "awaiting_anchor"} | yes |
| regtest | L6 | required | b3 members while awaiting the anchor | {"o5": "issuing"} | {"o5": "issuing"} | yes |
| regtest | L6 | required | certificate status after mining 28 blocks to the anchor at 4140 | {"status": "verified", "seconds_waited_for_anchor_after_tip": 0.0} | {"status": "verified"} | yes |
| regtest |  | required | certificates for b3 verified with libveritas | {"notify": true, "results": {"o5": {"ok": true, "checks": {"verified": true, "handle": true, "script_pubkey": true, "root": true, "root_height": true, "sovereign": true}, "error": null, "zone": {"anchor": 4140, "canon... |  | yes |
| regtest |  | required | b3 members after verification | {"o5": "ready"} | {"o5": "ready"} | yes |
| regtest |  | required | no name committed twice | {"committed": ["four", "one", "three", "two"]} | {"unique": true} | yes |

## 5. continued operation after recovery

| label | case | kind | step | regtest result | model expects | agree |
| --- | --- | --- | --- | --- | --- | --- |
| regtest | R13 | informational | subs' view of b3 before the next batch | {"subs_commitment_idx": 2, "subs_txid": null, "subs_current_step": "broadcast", "subs_commit_status": {"status": "none", "txid": null, "block_height": null, "confirmations": null}, "controller_state": "final", "contro... |  |  |
| regtest |  | informational | recipient request for seven@test10000 | {"oid": "o6", "script_pubkey": "5120254e6262a29f2490d1a1745718bf96829f580e3668d44fbe839ef1e181a0cd05"} |  |  |
| regtest |  | required | fixed-price quote for o6 | {"quoted": true, "status": "quoted", "price_sats": 10000, "address": "bcrt1p8axnunywpgf9kj9fzchzp2tx8r74f5dspejyvmppd5lq6gxze7jsc88uf8"} | {"quoted": true, "status": "quoted", "price": 10000} | yes |
| regtest | P1 | required | payment at 3 conf | {"o6": "converted"} | {"o6": "converted"} | yes |
| regtest | U1(b) | required | attach the txid of b2 to b3 | {"attached": false, "answer": "POST /spaces/@test10000/commit/txid: HTTP 404: "} | {"attached": false} | yes |
| regtest | U1(b) | informational | attach the adopted txid of b3 to subs | {"attached": false, "answer": "POST /spaces/@test10000/commit/txid: HTTP 404: ", "subs_commit_status": {"status": "none", "txid": null, "block_height": null, "confirmations": null}} |  |  |
| regtest |  | required | freeze b4 | {"members": ["o6"], "state": "frozen"} | {"ok": true, "members": ["o6"], "state": "frozen", "refusal": null} | yes |
| regtest |  | informational | stage b4 with readback | {"staged": {"seven": "5120254e6262a29f2490d1a1745718bf96829f580e3668d44fbe839ef1e181a0cd05"}, "parked": [], "sync": {"success": true, "pulled": 1, "staged": 1, "errors": []}} |  |  |
| regtest | U1(b) | required | local commit of b4 after the recovery of b3 | {"allowed": false, "why": "POST /spaces/@test10000/commit: HTTP 500: {\"error\":\"cannot commit: previous commit not yet submitted on-chain\"}", "txid_attached": false} | {"allowed": true, "previous": "final"} | no |

## Findings recorded during the run

- R17: after a restore, subs refuses the next local commit for a later commitment it holds no txid for, although that commitment is final on chain: POST /spaces/@test10000/commit: HTTP 500: {"error":"cannot commit: previous commit not yet submitted on-chain"}
