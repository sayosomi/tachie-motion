"""Tests for duplicate names, hierarchy, and group visibility semantics."""

import unittest

from tachie_motion.psd.tree import walk_layers


class FakeLayer:
    def __init__(
        self, name, kind="pixel", visible=True, effective=True, children=()
    ):
        self.name = name
        self.kind = kind
        self.visible = visible
        self._effective = effective
        self.bbox = (1, 2, 30, 40)
        self.children = children

    def is_group(self):
        return self.kind == "group"

    def is_visible(self):
        return self._effective

    def __iter__(self):
        return iter(self.children)


class PSDTreeTests(unittest.TestCase):
    def test_duplicate_names_have_distinct_index_paths(self):
        root = [
            FakeLayer("mouth"),
            FakeLayer(
                "face",
                kind="group",
                children=(FakeLayer("mouth"), FakeLayer("mouth")),
            ),
            FakeLayer("mouth"),
        ]
        entries = list(walk_layers(root))
        self.assertEqual(
            [entry.index_path for entry in entries],
            [(0,), (1,), (1, 0), (1, 1), (2,)],
        )
        self.assertEqual(
            [entry.name for entry in entries],
            ["mouth", "face", "mouth", "mouth", "mouth"],
        )

    def test_raw_and_effective_visibility_are_separate(self):
        root = [
            FakeLayer(
                "hidden group",
                kind="group",
                visible=False,
                effective=False,
                children=(FakeLayer("eye", visible=True, effective=False),),
            )
        ]
        group, child = list(walk_layers(root))
        self.assertFalse(group.visible)
        self.assertTrue(child.visible)
        self.assertFalse(child.effective_visible)

    def test_empty_tree(self):
        self.assertEqual(list(walk_layers([])), [])


if __name__ == "__main__":
    unittest.main()
