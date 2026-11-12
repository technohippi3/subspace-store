"""Bound verified-certificate upload. Bytes are reconstructible local cache."""
import base64
import hashlib


def accept(store, batch, revision, oid, root, height, message, error):
    payload = dict(store._entry_payload(batch), delegate=batch["delegate_in"], revision=revision, oid=oid,
                   certificateRoot=root, certificateHeight=height, message_b64=base64.b64encode(message).decode())
    result = store.op("POST", "/operator/certificates", payload)
    expected = dict(oid=oid, entry=batch["entry_key"], revision=revision, certificateRoot=root,
                    certificateHeight=height, hash=hashlib.sha256(message).hexdigest(), length=len(message))
    if not isinstance(result, dict) or set(result) != set(expected) | {"acknowledged"} or \
            any(result[k] != v or type(result[k]) is not type(v) for k, v in expected.items()) or \
            type(result["acknowledged"]) is not bool:
        raise error("invalid or mismatched certificate acknowledgment")
    return result
