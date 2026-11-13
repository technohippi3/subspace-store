"""Explicit bound relay-delivery protocol; never anonymous fulfillment."""
import re


def status(store, batch, oid, error):
    payload = dict(store._entry_payload(batch), delegate=batch["delegate_in"], oid=oid)
    out = store.op("POST", "/operator/deliveries/lookup", payload)
    fields = {"oid", "entry", "revision", "certificateHash", "fulfilled", "acknowledged"}
    if not isinstance(out, dict) or set(out) != fields or out["oid"] != oid or out["entry"] != batch["entry_key"] or \
            type(out["revision"]) is not int or not 0 <= out["revision"] < 2**53 or \
            type(out["fulfilled"]) is not bool or type(out["acknowledged"]) is not bool or \
            (out["certificateHash"] is not None and (not isinstance(out["certificateHash"], str) or
             not re.fullmatch(r"[0-9a-f]{64}", out["certificateHash"]))) or \
            (out["acknowledged"] and (out["revision"] == 0 or out["certificateHash"] is None)):
        raise error("invalid or mismatched delivery status")
    return out


def fulfill(store, batch, revision, oid, certificate_hash, root, height, proof_hash, error):
    payload = dict(store._entry_payload(batch), delegate=batch["delegate_in"], oid=oid, revision=revision,
                   certificateHash=certificate_hash, relayRoot=root, relayHeight=height, proofHash=proof_hash)
    out = store.op("POST", "/operator/fulfillments", payload)
    if not isinstance(out, dict) or set(out) != {"oid", "entry", "fulfilled", "acknowledged"} or \
            out["oid"] != oid or out["entry"] != batch["entry_key"] or out["fulfilled"] is not True or type(out["acknowledged"]) is not bool:
        raise error("invalid or mismatched fulfillment acknowledgment")
    return out
