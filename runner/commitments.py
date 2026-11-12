"""Strict TypeScript commitment receipts. Registry observations do not send."""
import re


def receipt(result, payload, error):
    fields = {"entry", "root", "oids", "delegate", "revision", "observation", "acknowledged"}
    if not isinstance(result, dict) or set(result) != fields or \
            any(result[k] != payload[k] for k in ("entry", "root", "oids", "delegate")) or \
            type(result["revision"]) is not int or not 0 <= result["revision"] < 2**53 or \
            type(result["acknowledged"]) is not bool:
        raise error("invalid or mismatched commitment receipt")
    o = result["observation"]
    if o is None:
        if result["revision"] != 0 or "observation" in payload:
            raise error("missing commitment observation")
        return result
    keys = {"txid", "tipHeight", "tipHash", "minedHeight", "rootHeight", "anchorHeight", "phase", "depth", "covered"}
    if not isinstance(o, dict) or set(o) != keys or result["revision"] < 1:
        raise error("invalid commitment observation receipt")
    for key in ("txid", "tipHash"):
        if not isinstance(o[key], str) or not re.fullmatch(r"[0-9a-f]{64}", o[key]):
            raise error("invalid commitment hash receipt")
    for key in ("tipHeight", "minedHeight", "rootHeight", "anchorHeight"):
        if o[key] is None and key != "tipHeight":
            continue
        if type(o[key]) is not int or not 0 <= o[key] < 2**53 or o[key] > o["tipHeight"]:
            raise error("invalid commitment height receipt")
    depth = o["tipHeight"] - o["minedHeight"] if o["minedHeight"] is not None else None
    phase = "broadcast" if depth is None else "final" if depth >= 150 and o["rootHeight"] == o["minedHeight"] else "mined"
    covered = phase == "final" and o["anchorHeight"] is not None and o["anchorHeight"] - o["minedHeight"] >= 144
    if (o["rootHeight"] is not None and o["rootHeight"] != o["minedHeight"]) or \
            o["phase"] != phase or o["depth"] != depth or (depth is not None and type(o["depth"]) is not int) or \
            type(o["covered"]) is not bool or o["covered"] != covered:
        raise error("inconsistent commitment phase receipt")
    if "observation" in payload and (result["revision"] != payload["expectedRevision"] + 1 or
                                    any(o[k] != v for k, v in payload["observation"].items())):
        raise error("commitment report acknowledgment differs")
    return result
