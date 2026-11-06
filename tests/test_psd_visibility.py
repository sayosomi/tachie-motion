"""Tests for explicit layer edits; no real/private artwork needed."""

import unittest

from tachie_motion.psd.visibility import (
    apply_visibility,
    parse_index_path,
    resolve_layer,
)


class FakeLayer:
    def __init__(self, name, *, visible=True, children=None):
        self.name = name
        self.visible = visible
        self.children = children

    def is_group(self):
        return self.children is not None

    def __len__(self):
        return len(self.children or ())

    def __getitem__(self, item):
        return self.children[item]


class FakePSD:
    def __init__(self, *layers):
        self.layers = list(layers)

    def __len__(self):
        return len(self.layers)

    def __getitem__(self, item):
        return self.layers[item]


class VisibilityTests(unittest.TestCase):
    def setUp(self):
        self.closed = FakeLayer("mouth", visible=False)
        self.open = FakeLayer("mouth", visible=True)
        self.psd = FakePSD(
            FakeLayer("body"),
            FakeLayer("mouth group", children=[self.closed, self.open]),
            FakeLayer("mouth"),
        )

    def test_duplicate_names_changed_by_index_only(self):
        changes = apply_visibility(self.psd, show=["1/0"], hide=["1/1"])
        self.assertEqual([c.path for c in changes], [(1, 0), (1, 1)])
        self.assertTrue(self.closed.visible)
        self.assertFalse(self.open.visible)
        self.assertTrue(self.psd[2].visible)

    def test_invalid_path_does_not_partially_mutate(self):
        with self.assertRaisesRegex(ValueError, "not found"):
            apply_visibility(self.psd, hide=["1/1"], show=["1/9"])
        self.assertTrue(self.open.visible)

    def test_conflicting_edits_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "more than once"):
            apply_visibility(self.psd, show=["1/0"], hide=["1/0"])
        self.assertFalse(self.closed.visible)

    def test_hidden_ancestor_must_be_shown_explicitly(self):
        self.psd[1].visible = False
        with self.assertRaisesRegex(ValueError, "hidden group"):
            apply_visibility(self.psd, show=["1/0"])
        self.assertFalse(self.closed.visible)
        apply_visibility(self.psd, show=["1", "1/0"])
        self.assertTrue(self.psd[1].visible)
        self.assertTrue(self.closed.visible)

    def test_path_parsing_and_leaf_traversal(self):
        self.assertEqual(parse_index_path("1/0"), (1, 0))
        self.assertIs(resolve_layer(self.psd, (1, 1)), self.open)
        for raw in ("", "/1", "1/", "a/0", "-1/0", "1/ 0"):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    parse_index_path(raw)
        with self.assertRaisesRegex(ValueError, "non-group"):
            resolve_layer(self.psd, (2, 0))

    def test_requires_explicit_override(self):
        with self.assertRaisesRegex(ValueError, "At least one"):
            apply_visibility(self.psd)


if __name__ == "__main__":
    unittest.main()
