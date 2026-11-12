#!/usr/bin/env python3
"""Pinned local binaries, explicit wallets and coherent indexed native nodes."""
import argparse
import base64
import json
import hashlib
from pathlib import Path
import platform
import re
import sys
import urllib.parse
import urllib.request

from common import command, config, json_file, require
from release import digest_file
from credential_file import protected


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("native RPC redirected")


def rpc(url, cookie, method, parameters=None, wallet=None):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "::1") and parsed.username is None and parsed.password is None and
        not parsed.query and not parsed.fragment, "local-rpc-required")
    token = protected(cookie,4096)
    require(1 <= len(token) <= 4096, "native-cookie-unavailable")
    endpoint = url.rstrip("/") + ("/wallet/" + urllib.parse.quote(wallet, safe="") if wallet is not None else "")
    request = urllib.request.Request(endpoint, data=json.dumps({"jsonrpc": "2.0", "id": "preflight", "method": method,
        "params": [] if parameters is None else parameters}).encode(), headers={"Authorization": "Basic " + base64.b64encode(token.strip()).decode(), "Content-Type": "application/json"})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=5) as response:
        data = response.read(1024 * 1024 + 1)
    require(len(data) <= 1024 * 1024, "native-rpc-response-oversize")
    value = json.loads(data)
    require(value.get("error") is None, "native-rpc-refused")
    return value["result"]


def preflight(value):
    release = Path(__file__).resolve().parent.parent
    profile = json_file(release / "native-artifacts.json")
    require(sys.version_info[:2] == (3, 12) and int(command(["/usr/bin/openssl", "version"]).split()[1].split(b".")[0]) == 3, "native-runtime-prerequisite-mismatch")
    for name, artifact in profile["artifacts"].items():
        binary = release / artifact["path"]
        require(binary.is_file() and not binary.is_symlink() and digest_file(binary) == artifact["sha256"], "pinned-native-binary-mismatch")
        # ELF dependencies must resolve on this actual host. Static binaries
        # and the reviewed export script need no dynamic loader inspection.
        with binary.open("rb") as file:
            is_elf = file.read(4) == b"\x7fELF"
        if is_elf:
            require(b"not found" not in command(["/usr/bin/ldd", str(binary)]), "native-library-unavailable")
    require(command([str(release / "bin/node"), "--version"]).strip() == b"v24.14.0", "pinned-node-version-mismatch")
    runtime, runner = json_file(value["storeConfig"]), json_file(value["runnerConfig"])
    require(runtime["version"] == 2 and runtime["network"] in ("main", "regtest") and
            runtime["network"] == ("main" if value["network"] == "mainnet" else "regtest"), "explicit-runtime-network-required")
    core = value.get('nativeRpc', {}).get('core', runtime['core'])
    chain = rpc(core["url"], core["cookiePath"], "getblockchaininfo")
    require(chain["chain"] == runtime["network"] and chain.get("initialblockdownload") is False, "core-not-ready")
    require(type(chain.get('blocks')) is int and chain.get('headers') == chain['blocks'] and
            isinstance(chain.get('bestblockhash'),str),'core-not-current')
    require(rpc(core['url'],core['cookiePath'],'getnetworkinfo').get('version') == 310200 and
            rpc(core['url'],core['cookiePath'],'getmempoolinfo').get('loaded') is True,'core-not-ready')
    require(rpc(core["url"], core["cookiePath"], "getblockhash", [0]) == runtime["installation"]["genesis"], "core-genesis-mismatch")
    wallet = rpc(core["url"], core["cookiePath"], "getwalletinfo", wallet=core["wallet"])
    require(wallet.get("walletname") == core["wallet"] and wallet.get("descriptors") is True and wallet.get("private_keys_enabled") is True and wallet.get("scanning") is False, "explicit-wallet-not-ready")
    processed=wallet.get('lastprocessedblock',{})
    require(isinstance(processed,dict) and processed.get('height') == chain['blocks'] and
            processed.get('hash') == chain['bestblockhash'],'payment-wallet-not-current')
    descriptors = rpc(core["url"], core["cookiePath"], "listdescriptors", [False], wallet=core["wallet"])
    require(descriptors.get("wallet_name") == core["wallet"], "wallet-descriptor-unavailable")
    expressions = [row.get("desc") for row in descriptors.get("descriptors", [])]
    require(1 <= len(expressions) <= 1000 and all(isinstance(desc, str) and 1 <= len(desc) <= 16384 and
            all(32 <= ord(character) <= 126 for character in desc) for desc in expressions) and len(set(expressions)) == len(expressions), "wallet-descriptor-unavailable")
    observed = hashlib.sha256(json.dumps(sorted(expressions), separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    require(observed == runtime["installation"]["descriptorHash"], "wallet-descriptor-identity-mismatch")
    # Never create/import/unlock a wallet or ask for private descriptors.
    spaced = value.get('nativeRpc', {}).get('spaced', {'url':runner['spaced']['url'],'cookiePath':runner['spaced']['cookie_file']})
    info = rpc(spaced["url"], spaced["cookiePath"], "getserverinfo")
    require(info.get("network") == value["network"], "spaced-network-mismatch")
    require(info.get('tip',{}).get('hash') == chain['bestblockhash'] and
            info.get('tip',{}).get('height') == chain['blocks'],'spaced-not-current')
    header = rpc(core["url"], core["cookiePath"], "getblockheader", [info["tip"]["hash"]])
    require(header.get("confirmations", 0) >= 1, "spaced-chain-mismatch")
    operator_wallet = rpc(spaced["url"], spaced["cookiePath"], "walletgetinfo", [runner["controller"]["operator_wallet"]])
    require(operator_wallet.get("tip") == header["height"], "operator-wallet-not-synced")
    if value["network"] == "mainnet":
        indexes = rpc(core["url"], core["cookiePath"], "getindexinfo")
        require(indexes.get("txindex", {}).get("synced") is True, "indexed-core-required")
        require(runner.get("public_pilot", {}).get("version") == 1 and runner["store"]["implementation"] == "typescript" and "private_purchase" not in runner,
                "explicit-public-pilot-required")
    after = rpc(core['url'],core['cookiePath'],'getblockchaininfo')
    require(after.get('bestblockhash') == chain['bestblockhash'] and after.get('blocks') == chain['blocks'] and
            after.get('headers') == chain['blocks'] and after.get('initialblockdownload') is False,'native-tip-changed')
    return {"ready": True, "network": value["network"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(preflight(config(args.config))))
    except Exception:
        print(json.dumps({"ready": False, "code": "native-host-preflight-refused"}))
        raise SystemExit(2)
