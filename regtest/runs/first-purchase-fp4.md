# Regtest run report

Every result below is labelled "regtest": the pinned bitcoind, spaced and
subs on a local regtest network, driven by the harness in `regtest/`. None
of it is model, integration, mainnet or buyer-acceptance evidence. The
"model" column is what the reference model expects for the same events.

- label: regtest
- run: fp4
- pins: {'SUBS_REPO': 'https://github.com/spacesprotocol/subs', 'SUBS_COMMIT': '4dcc9237af3a807497d4b1532729842ee5dcdb68', 'SPACES_REPO': 'https://github.com/spacesprotocol/spaces', 'SPACES_TAG': 'spaces_client-v0.5.0', 'SPACES_COMMIT': '77653f01889ddc86337e4b27d7d3ae4fc334a117', 'BITCOIN_VERSION': '26.0', 'BITCOIN_TARBALL': 'bitcoin-26.0-x86_64-linux-gnu.tar.gz', 'BITCOIN_URL': 'https://bitcoincore.org/bin/bitcoin-core-26.0/bitcoin-26.0-x86_64-linux-gnu.tar.gz', 'BITCOIN_SHA256': '23e5ab226d9e01ffaadef5ffabe8868d0db23db952b90b0593652993680bb8ab'}


## 1. first purchase

| label | case | step | regtest result | model expects | agree |
| --- | --- | --- | --- | --- | --- |
| regtest |  | recipient request for one@test10000 | {"oid": "o1", "script_pubkey": "51206d4067154070d9cebe12b603c05d0698228c9d0870a50c57f89d9c100d96fd16"} |  |  |
| regtest |  | fixed-price quote for o1 | {"price_sats": 10000, "address": "bcrt1pc7ynyh7w7t6crmp22szmqu4t52qvcedhcvj67far85lxd78dnl9slwrp7v"} | {"quoted": true} | yes |
| regtest | Q1 | second quote for the held name | {"quoted": false, "why": "taken for now"} | {"quoted": false, "why": "taken for now"} | yes |
| regtest |  | payment at 1 conf | {"o1": "quoted"} | {"o1": "quoted"} | yes |
| regtest | P1 | payment at 3 conf converts the hold | {"o1": "converted"} | {"o1": "converted"} | yes |
| regtest |  | freeze b1 | {"members": ["o1"], "state": "frozen"} | {"members": ["o1"]} | yes |
| regtest |  | stage b1 with readback | {"staged": {"one": "51206d4067154070d9cebe12b603c05d0698228c9d0870a50c57f89d9c100d96fd16"}, "parked": [], "sync": {"success": true, "pulled": 1, "staged": 1, "errors": []}} |  |  |
| regtest |  | local commit b1 with readback | {"root": "6785a0291a679e44fdb02c98ffcfaaa4f43a1564e0aa9d4f18337145a377ccef", "prev_root": null, "is_initial": true, "handles": 1} | {"state": "committed_local"} | yes |
| regtest |  | prove b1 | {"seconds": 0.0, "proving": "skipped", "proof_total": null} | {"state": "proved"} | yes |
| regtest |  | checkpoint b1 (coordinated snapshot) | {"dir": "regtest/.run/fp4/offhost/snapshots/001-b1", "objects": 8, "store_journal": 5, "controller_journal": 5} | {"state": "checkpointed"} | yes |
| regtest | B3 | binding check passes; members issuing | {"o1": "issuing"} | {"o1": "issuing"} | yes |
| regtest | B3 | b1 broadcast | {"state": "broadcast", "txid": "77d7729dbbdb0a472ab5cca43973fc442d56eec82e6e11bac5826756d177c44a"} | {"state": "broadcast"} | yes |
| regtest | X3 | cancellation after issuing | {"cancelled": false, "why": "not cancellable once issuing"} | {"cancelled": false, "why": "not cancellable once issuing"} | yes |
| regtest |  | b1 mined at d = 0 | {"state": "mined", "position": [3454, 0]} | {"state": "mined"} | yes |
| regtest |  | b1 at d = 149 | {"state": "mined"} | {"state": "mined"} | yes |
| regtest |  | b1 at d = 150 | {"state": "final", "subs_commit_status": {"status": "finalized", "txid": null, "block_height": 3454, "confirmations": null}} | {"state": "final"} | yes |
| regtest |  | certificates for b1 verified with libveritas | {"notify": true, "results": {"o1": {"ok": true, "checks": {"verified": true, "handle": true, "script_pubkey": true, "root": true, "root_height": true, "sovereign": true}, "error": null, "zone": {"anchor": 3600, "canon... |  | yes |
| regtest |  | b1 members after verification | {"o1": "ready"} | {"o1": "ready"} | yes |
| regtest | L1 | b1 after a 151-block reorg drops the commitment | {"state": "broadcast", "in_mempool": false, "getcommitment": null, "subs_commit_status": {"status": "pending", "txid": "77d7729dbbdb0a472ab5cca43973fc442d56eec82e6e11bac5826756d177c44a", "block_height": null, "confirm... | {"state": "broadcast"} | yes |
| regtest | L1 | members while finality is lost | {"o1": "issuing"} | {"o1": "issuing"} | yes |
| regtest | L1 | cancellation while finality is lost | {"cancelled": false, "why": "not cancellable once issuing"} | {"cancelled": false, "why": "not cancellable once issuing"} | yes |
| regtest | L1 | certificate verification while not final | {"allowed": false, "why": "not final"} | {"allowed": false} | yes |
| regtest | L1 | commitment back in the node's mempool after the reorg | {"in_mempool": false, "testmempoolaccept": true} | {"in_mempool": true} | no |
| regtest |  | harness resubmits the identical signed commitment (stand-in for a peer) | {"in_mempool": true} |  |  |
| regtest | L1 | b1 mined again at d = 0 | {"state": "mined", "position": [3606, 0]} | {"state": "mined"} | yes |
| regtest | L2 | b1 back at d >= 150 | {"state": "final", "subs_commit_status": {"status": "finalized", "txid": null, "block_height": 3606, "confirmations": null}} | {"state": "final"} | yes |
| regtest |  | certificates for b1 verified with libveritas | {"notify": true, "results": {"o1": {"ok": false, "checks": {"verified": true, "handle": true, "script_pubkey": true, "root": true, "root_height": true, "sovereign": false}, "error": null, "zone": {"anchor": 3744, "can... |  | no |
| regtest |  | mine 24 blocks to the anchor at 3780 | {"anchors_newest": 3780} |  |  |
| regtest |  | certificates for b1 verified with libveritas (again) | {"notify": true, "results": {"o1": {"ok": true, "checks": {"verified": true, "handle": true, "script_pubkey": true, "root": true, "root_height": true, "sovereign": true}, "error": null, "zone": {"anchor": 3780, "canon... |  | yes |
| regtest |  | b1 members after verification | {"o1": "ready"} | {"o1": "ready"} | yes |
