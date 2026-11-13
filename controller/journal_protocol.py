"""Mandatory records use framing that legacy JSON-only readers cannot skip."""
import json

PREFIX = "SSCJ3 "
FEATURES = ["preparation_abort_v1"]


def protocol_record(row):
    if not isinstance(row, dict) or set(row) != {"seq", "kind", "version", "requires"} or \
            row["kind"] != "controller_protocol" or type(row["seq"]) is not int or row["seq"] < 1 or \
            type(row["version"]) is not int or row["version"] != 3 or row["requires"] != FEATURES:
        raise ValueError("unsupported mandatory controller journal protocol")


def encode_record(row):
    if row.get("kind") == "controller_protocol":
        protocol_record(row)
        return PREFIX + json.dumps(row, sort_keys=True, separators=(",", ":"))
    return json.dumps(row, sort_keys=True)


def decode_record(raw):
    framed = raw.startswith(PREFIX)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate mandatory controller protocol field")
            result[key] = value
        return result
    row = json.loads(raw[len(PREFIX):] if framed else raw, object_pairs_hook=unique if framed else None)
    if framed or isinstance(row, dict) and row.get("kind") == "controller_protocol":
        if not framed:
            raise ValueError("mandatory controller protocol record lacks framing")
        protocol_record(row)
    return row


def require_abort_protocol(journal):
    if not any(row.get("kind") == "controller_protocol" for row in journal.entries()):
        journal.append("controller_protocol", version=3, requires=FEATURES)
    if journal.down() or not any(row.get("kind") == "controller_protocol" for row in journal.entries()):
        raise ValueError("mandatory controller protocol not acknowledged")


def upgrade_abort_history(journal):
    rows = journal.entries()
    if any(row.get("kind") == "preparation_abort" for row in rows) and not any(row.get("kind") == "controller_protocol" for row in rows):
        require_abort_protocol(journal)
