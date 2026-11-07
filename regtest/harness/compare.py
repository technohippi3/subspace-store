"""Comparisons between a regtest result and the model's expectation.

Each function takes what the real software did and what the model did for
the same events, and says whether they agree. They are pure, so the unit
tests in `tests/test_regtest_compare.py` can show that a mismatch on any
field makes a required step disagree, and the run's verdict fail, without
starting the regtest stack.

Regtest harness tooling. A result from it is a regtest result.
"""


def same_quote(regtest, model):
    """regtest: {"quoted", "status", "price_sats"} from the registry.
    model: {"quoted", "status", "price"} from the mirror."""
    return (regtest["quoted"] == model["quoted"]
            and regtest["status"] == model["status"]
            and regtest["price_sats"] == model["price"])


def same_freeze(regtest, model):
    """regtest: {"members", "state"} of the controller's batch.
    model: {"ok", "members", "state"}; members is None when the model refused."""
    if not model["ok"]:
        return False
    return (sorted(regtest["members"]) == sorted(model["members"])
            and regtest["state"] == model["state"])


def same_local_commit(regtest, model):
    """regtest: {"state", "handles", "root", "members_on_root"} after the local
    commit and its readback: "members_on_root" counts the members whose
    readback shows the new root. model: {"state", "members"}."""
    root = regtest.get("root")
    return (regtest["state"] == model["state"]
            and regtest["handles"] == len(model["members"])
            and regtest["members_on_root"] == len(model["members"])
            and isinstance(root, str) and len(root) == 64)


def verification_allowed(model_certificate_status):
    """The model allows certificate verification, and so readiness, only when
    the certificate status is "verified" (L1, L6)."""
    return model_certificate_status == "verified"


def same_verification(regtest_allowed, model_certificate_status):
    return regtest_allowed == verification_allowed(model_certificate_status)
