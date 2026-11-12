"""Operator receipts and the shipped store/controller lifecycle commands."""
import json
from pathlib import Path
import urllib.request
from common import Refused, command, expand, json_file, require
from credential_file import protected


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Refused("operator-redirect-refused")


def operator(config, path, body=None):
    credential = Path(config["operator"]["credentialFile"])
    require(credential.is_file() and not credential.is_symlink() and not credential.stat().st_mode & 0o077, "operator-credential-unavailable")
    token = protected(credential, 256).decode().strip()
    require(32 <= len(token) <= 256 and all(33 <= ord(c) <= 126 for c in token), "operator-credential-unavailable")
    request = urllib.request.Request(config["operator"]["url"] + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
            raw = response.read(1024 * 1024 + 1)
        require(len(raw) <= 1024 * 1024, "operator-response-oversize")
        return json.loads(raw)
    except Exception:
        raise Refused("operator-unavailable") from None


def maintenance(config):
    value = operator(config, "/operator/maintenance")
    require(set(value) == {"paused", "reviewCount", "blockers", "ready", "acknowledged", "chain"} and
            type(value["paused"]) is bool and type(value["reviewCount"]) is int and value["reviewCount"] >= 0 and
            type(value["ready"]) is bool and type(value["acknowledged"]) is bool and isinstance(value["blockers"], list), "invalid-maintenance-receipt")
    for blocker in value["blockers"]:
        require(set(blocker) == {"kind", "id"} and isinstance(blocker["kind"], str) and isinstance(blocker["id"], str), "invalid-maintenance-receipt")
    return value


def pause(config, paused=True):
    result = operator(config, "/operator/pause", {"paused": paused})
    require(result.get("paused") is paused and result.get("acknowledged") is True, "pause-not-acknowledged")


def unknown_invoice_count(config):
    value = operator(config, "/operator/status")
    count = value.get("unknown_payment_history")
    require(type(count) is int and count >= 0 and value.get('acknowledged') is True and value.get('paused') is True,
        "unknown-history-status-required")
    return count


def lifecycle(config, release, name):
    value = json.loads(command(expand(config, release, config["commands"][name]), cwd=release, timeout=300))
    require(isinstance(value, dict), "invalid-lifecycle-response")
    if name == "preflight":
        require(value.get("ready") is True and value.get("network") == config["network"], "host-not-ready")
    elif name == "reconcile":
        require(value.get("acknowledged") is True, "reconciliation-not-acknowledged")
    else:
        require(value.get("ready") is True and value.get("acknowledged") is True, "controller-not-ready")
    return value
