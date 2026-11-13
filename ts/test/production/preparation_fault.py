"""A crash after a real preparation intent; no native effect is repeated."""
from controller.preparation_history import PreparationBarrier, history


def retain_unrelated_owner(journal):
    if history(journal)[0] is not None:
        return
    b = dict(bid="b2", space="@other", members=["o3"], digest="d" * 64)
    barrier = PreparationBarrier(journal)
    barrier.acquire(b)
    def no_reply(): raise ConnectionError("recording staging request with no reply")
    try:
        barrier.effect(b, "sync", [], no_reply)
    except ConnectionError:
        pass
