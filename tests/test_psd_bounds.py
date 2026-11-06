"""Test bounds invariance across hidden alternatives and edge cases."""

import unittest

from tachie_motion.psd.bounds import compute_fixed_bounds, leaf_bboxes


class FakeLayer:
    def __init__(self, bbox, children=None):
        self.bbox = bbox
        self.children = children

    def is_group(self):
        return self.children is not None

    def __iter__(self):
        return iter(self.children or ())


class FixedBoundsTests(unittest.TestCase):
    def test_includes_hidden_alternatives_not_group_bounds(self):
        # The group's bbox resembles only its currently displayed child.
        tree = [
            FakeLayer((20, 20, 40, 40), children=[
                FakeLayer((20, 20, 40, 40)),
                FakeLayer((5, 7, 80, 90)),  # Hidden alternative
            ]),
            FakeLayer((50, 10, 95, 95)),
        ]
        boxes = list(leaf_bboxes(tree))
        self.assertEqual(boxes, [
            (20, 20, 40, 40),
            (5, 7, 80, 90),
            (50, 10, 95, 95),
        ])
        result = compute_fixed_bounds(
            boxes, canvas_width=100, canvas_height=100, padding=2
        )
        self.assertEqual(result.box, (3, 5, 97, 97))
        self.assertEqual(result.origin, (3, 5))
        self.assertEqual((result.width, result.height), (94, 92))
        self.assertEqual(result.included_layers, 3)

    def test_clips_to_original_canvas(self):
        result = compute_fixed_bounds(
            [(-10, -20, 110, 140)],
            canvas_width=100,
            canvas_height=100,
            padding=16,
        )
        self.assertEqual(result.box, (0, 0, 100, 100))

    def test_skips_empty_and_outside_boxes(self):
        result = compute_fixed_bounds(
            [(1, 1, 1, 9), (150, 150, 200, 200), (10, 20, 30, 40)],
            canvas_width=100,
            canvas_height=100,
            padding=0,
        )
        self.assertEqual(result.box, (10, 20, 30, 40))
        self.assertEqual(result.included_layers, 1)
        self.assertEqual(result.excluded_layers, 2)

    def test_odd_width_preserves_anchor_and_pads_right(self):
        result = compute_fixed_bounds(
            [(10, 10, 111, 51)], canvas_width=150, canvas_height=100, padding=0
        )
        self.assertEqual(result.box, (10, 10, 112, 52))
        self.assertEqual(result.width % 2, 0)
        self.assertEqual(result.height % 2, 0)
        self.assertEqual(result.origin, (10, 10))

    def test_odd_width_at_canvas_edge_allows_transparent_padding(self):
        result = compute_fixed_bounds(
            [(0, 0, 101, 20)], canvas_width=101, canvas_height=20, padding=0
        )
        self.assertEqual(result.box, (0, 0, 102, 20))
        self.assertEqual(result.origin, (0, 0))

    def test_odd_height_preserves_origin_and_pads_bottom(self):
        result = compute_fixed_bounds(
            [(10, 10, 50, 45)], canvas_width=64, canvas_height=64,
            padding=0,
        )
        self.assertEqual(result.box, (10, 10, 50, 46))
        self.assertEqual((result.width, result.height), (40, 36))
        self.assertEqual(result.origin, (10, 10))

    def test_odd_height_at_canvas_edge_extends_bottom_transparently(self):
        result = compute_fixed_bounds(
            [(0, 0, 20, 35)], canvas_width=20, canvas_height=35,
            padding=0,
        )
        self.assertEqual(result.box, (0, 0, 20, 36))
        self.assertEqual(result.origin, (0, 0))
        self.assertEqual(result.height % 2, 0)

    def test_invalid_inputs_and_empty_canvas(self):
        with self.assertRaisesRegex(ValueError, "positive dimensions"):
            compute_fixed_bounds([], canvas_width=0, canvas_height=100)
        with self.assertRaisesRegex(ValueError, "Padding"):
            compute_fixed_bounds([], canvas_width=100, canvas_height=100, padding=-1)
        with self.assertRaisesRegex(ValueError, "No nonempty"):
            compute_fixed_bounds(
                [(0, 0, 0, 0)],
                canvas_width=100,
                canvas_height=100,
            )


if __name__ == "__main__":
    unittest.main()
