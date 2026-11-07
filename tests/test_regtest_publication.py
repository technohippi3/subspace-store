"""The regtest harness's publication comparisons, without the regtest stack.

A publication step must disagree with the model when `/publish` was called
and the model allowed no call (an empty chunk, or a batch whose certificates
don't verify), when it wasn't called and the model allowed one, and when the
answer or the handles read back as "final" differ. A delivery step must
disagree when the confirmation or the order's status differs. This tests
harness code only: it is neither model nor regtest evidence about the store.
"""

import unittest

from regtest.harness import compare

CALLED = {"called": True, "chunk": 1, "response": {"handles_published": 1, "remaining": 0},
          "final": ["o1"]}
ALLOWED = {"ok": True, "count": 1, "published": ["o1"]}


class Publish(unittest.TestCase):
    def test_a_call_agrees_with_an_allowed_chunk(self):
        self.assertTrue(compare.same_publish(CALLED, ALLOWED))

    def test_each_field_of_a_call_matters(self):
        for key, value in (("chunk", 2), ("response", {"handles_published": 0, "remaining": 1}),
                           ("final", [])):
            with self.subTest(key=key):
                self.assertFalse(compare.same_publish(dict(CALLED, **{key: value}), ALLOWED))
        self.assertFalse(compare.same_publish(CALLED, dict(ALLOWED, published=[])))
        self.assertFalse(compare.same_publish(CALLED, dict(ALLOWED, count=2)))

    def test_an_empty_chunk_is_never_a_call(self):
        empty = {"ok": True, "count": 0, "published": []}
        self.assertTrue(compare.same_publish({"called": False}, empty))
        self.assertFalse(compare.same_publish(dict(CALLED, chunk=0, final=[]), empty))

    def test_a_refused_publish_must_not_be_a_call(self):
        refused = {"ok": False, "count": 0, "published": []}
        self.assertTrue(compare.same_publish({"called": False, "why": "live check"}, refused))
        self.assertFalse(compare.same_publish(CALLED, refused))
        self.assertFalse(compare.same_publish({"called": False}, ALLOWED))


class Delivery(unittest.TestCase):
    def test_confirmation_and_status_both_matter(self):
        got = {"confirmed": True, "status": "fulfilled"}
        exp = {"ok": True, "status": "fulfilled"}
        self.assertTrue(compare.same_delivery(got, exp))
        self.assertFalse(compare.same_delivery(dict(got, confirmed=False), exp))
        self.assertFalse(compare.same_delivery(got, dict(exp, status="ready")))
        self.assertTrue(compare.same_delivery({"confirmed": False, "status": "ready"},
                                              {"ok": False, "status": "ready"}))


if __name__ == "__main__":
    unittest.main()
