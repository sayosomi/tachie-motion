"""Synthetic PSD validation of blink closed-eye visibility (Issue #34)."""

import unittest

from PIL import Image
from psd_tools import PSDImage

from tachie_motion.psd.tree import walk_layers
from tachie_motion.web.eye_renderer import validate_closed_eye


class ClosedEyeTests(unittest.TestCase):
    def setUp(self):
        self.psd = PSDImage.new(mode="RGB", size=(32, 32), depth=8)
        self.mouth_group = self.psd.create_group(name="mouth")
        self.mouth_group.create_pixel_layer(
            Image.new("RGBA", (4, 4), (4, 5, 6, 255)),
            name="mouth", left=1, top=1,
        )
        self.eye_group = self.psd.create_group(name="eyes")
        for name in ("*open", "*closed", "!always"):
            self.eye_group.create_pixel_layer(
                Image.new("RGBA", (4, 4), (4, 5, 6, 255)),
                name=name, left=1, top=1,
            )
        summaries = tuple(walk_layers(self.psd))
        by_name = {item.name: item.index_path for item in summaries}
        self.open_path = by_name["*open"]
        self.closed_path = by_name["*closed"]
        self.always_path = by_name["!always"]
        self.eye_path = by_name["eyes"]
        self.mouth_path = next(
            item.index_path for item in summaries
            if item.name == "mouth" and item.kind == "group"
        )
        self.base = {
            item.index_path: item.index_path != self.closed_path
            for item in summaries
        }

    @staticmethod
    def text(path):
        return "/".join(map(str, path))

    def shape(self, *selected):
        selected_set = set(selected)
        return {
            "opened": [],
            "closed": [
                {"path": self.text(path), "visible": path in selected_set}
                for path in (self.open_path, self.closed_path)
            ],
        }

    def validate(self, shape=None, **changes):
        if shape is None:
            shape = self.shape(self.closed_path)
        args = dict(
            psd=self.psd, base=self.base, eyes=shape,
            eye_groups=[self.text(self.eye_path)],
            mouth_groups=[self.text(self.mouth_path)],
        )
        args.update(changes)
        return validate_closed_eye(**args)

    def test_closed_pose_switches_only_eye_leaves(self):
        before = {item.index_path: item.visible for item in walk_layers(self.psd)}
        closed = self.validate()
        self.assertFalse(closed[self.open_path])
        self.assertTrue(closed[self.closed_path])
        self.assertTrue(closed[self.always_path])
        self.assertEqual(closed[self.mouth_path], self.base[self.mouth_path])
        self.assertEqual(
            {item.index_path: item.visible for item in walk_layers(self.psd)},
            before,
        )

    def test_can_explicitly_select_same_open_eye_as_fixed(self):
        closed = self.validate(self.shape(self.open_path))
        self.assertTrue(closed[self.open_path])
        self.assertFalse(closed[self.closed_path])
        self.assertEqual(closed, self.base)

    def test_rejects_unselected_malformed_or_legacy_shapes(self):
        cases = [
            {"opened": [], "closed": []},
            self.shape(),
            {"opened": [{"path": self.text(self.open_path), "visible": True}],
             "closed": self.shape(self.closed_path)["closed"]},
            {"opened": [], "closed": [{"path": self.text(self.closed_path),
                                      "visible": "true"}]},
            {"opened": [], "closed": [{"path": self.text(self.closed_path),
                                      "visible": True}] * 2},
        ]
        for eyes in cases:
            with self.subTest(eyes=eyes), self.assertRaises(ValueError):
                self.validate(eyes)

    def test_rejects_invalid_groups_hidden_parent_and_conflicts(self):
        group = self.text(self.eye_path)
        mouth = self.text(self.mouth_path)
        for changes in (
            {"eye_groups": []},
            {"eye_groups": [group, group]},
            {"eye_groups": [mouth]},
            {"eye_groups": [group], "mouth_groups": [group]},
            {"eye_groups": [group], "mouth_groups": ["999"]},
            {"base": {**self.base, self.eye_path: False}},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.validate(**changes)

    def test_rejects_psdtool_conflicting_radio_or_mandatory_target(self):
        for eyes in (
            self.shape(self.open_path, self.closed_path),
            {"opened": [], "closed": [
                {"path": self.text(self.closed_path), "visible": True},
                {"path": self.text(self.always_path), "visible": False},
            ]},
        ):
            with self.subTest(eyes=eyes), self.assertRaises(ValueError):
                self.validate(eyes)


if __name__ == "__main__":
    unittest.main()
