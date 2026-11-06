"""Characterization checks of partial PSD compositing feature warnings."""

import unittest

from psd_tools.constants import BlendMode
from tachie_motion.psd.fidelity import find_fidelity_risks


class FakeLayer:
    def __init__(
        self, name, *, kind="pixel", blend=BlendMode.NORMAL,
        clipping=False, mask=False, vector_mask=False, effects=None,
        children=None,
    ):
        self.name = name
        self.kind = kind
        self.blend_mode = blend
        self.clipping = clipping
        self.mask = mask
        self.vector_mask = vector_mask
        self.effects = effects
        self.children = children

    def is_group(self):
        return self.kind == "group"

    def __iter__(self):
        return iter(self.children or ())

    def has_mask(self):
        return self.mask

    def has_vector_mask(self):
        return self.vector_mask


class FidelityRiskTests(unittest.TestCase):
    def test_basic_pixel_group_has_no_warning(self):
        root = [FakeLayer("face", kind="group", children=[
            FakeLayer("mouth"),
        ])]
        self.assertEqual(list(find_fidelity_risks(root)), [])

    def test_masks_clipping_effects_and_blend_are_flagged(self):
        tree = [FakeLayer("group", kind="group", children=[
            FakeLayer(
                "complex", blend=BlendMode.MULTIPLY, clipping=True,
                mask=True, vector_mask=True, effects=["glow"],
            ),
            FakeLayer("curve", kind="adjustment"),
        ])]
        risks = list(find_fidelity_risks(tree))
        self.assertEqual([r.feature for r in risks], [
            "blend-mode", "clipping", "pixel-mask",
            "vector-mask", "effects", "layer-kind",
        ])
        self.assertEqual({r.index_path for r in risks}, {(0, 0), (0, 1)})


if __name__ == "__main__":
    unittest.main()
