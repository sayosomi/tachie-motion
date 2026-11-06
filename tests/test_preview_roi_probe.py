"""Synthetic tests for the Issue #47 ROI experiment; not a real-PSD speed gate."""

from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import tempfile
import unittest

from PIL import Image
from psd_tools import PSDImage

from scripts.probe_psd_preview_roi import (
    clipped_bbox, patch_matches_full, probe, render_region,
)
from tachie_motion.psd.raster import composite_rgba
from tachie_motion.psd.visibility import resolve_layer


class PreviewRegionProbeTests(unittest.TestCase):
    def test_crop_and_patch_bytes_include_alpha_and_transparent_rgb(self):
        original = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
        changed = original.copy()
        changed.putpixel((1, 1), (125, 100, 20, 128))
        part = changed.crop((1, 1, 2, 2))
        self.assertEqual(
            patch_matches_full(original, changed, part, (1, 1, 2, 2)),
            (True, True, True),
        )
        invalid = Image.new("RGBA", (1, 1), (125, 100, 20, 129))
        self.assertEqual(
            patch_matches_full(original, changed, invalid, (1, 1, 2, 2)),
            (False, False, True),
        )

    def test_roi_cannot_approve_change_outside_proposed_rectangle(self):
        original = Image.new("RGBA", (5, 5), (0, 0, 0, 0))
        changed = original.copy()
        changed.putpixel((1, 1), (255, 0, 0, 128))
        changed.putpixel((4, 4), (0, 10, 255, 255))
        part = changed.crop((1, 1, 2, 2))
        self.assertEqual(
            patch_matches_full(original, changed, part, (1, 1, 2, 2)),
            (True, False, True),
        )

    def test_empty_and_clipped_bboxes(self):
        self.assertEqual(clipped_bbox((-10, -4, 9, 7), 20, 20), (0, 0, 9, 7))
        self.assertIsNone(clipped_bbox((30, 30, 40, 40), 20, 20))

    def test_real_psd_tools_roi_and_unmodified_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "合成 た\u3099んもん.psd"
            doc = PSDImage.new(mode="RGB", size=(48, 48), depth=8)
            group = doc.create_group(name="eyes")
            group.create_pixel_layer(
                Image.new("RGBA", (12, 12), (255, 0, 0, 180)),
                name="mouth", left=10, top=10,
            )
            doc.create_pixel_layer(
                Image.new("RGBA", (42, 42), (0, 90, 255, 110)),
                name="background", left=3, top=3,
            )
            doc.save(source)
            before = source.read_bytes()
            psd = PSDImage.open(source)
            layer = resolve_layer(psd, (0, 0))
            original = composite_rgba(psd)
            layer.visible = False
            changed = composite_rgba(psd)
            region = render_region(psd, (10, 10, 22, 22))
            self.assertEqual(
                patch_matches_full(original, changed, region, (10, 10, 22, 22)),
                (True, True, True),
            )
            layer.visible = True
            with redirect_stdout(StringIO()) as output:
                probe(psd, ["0/0"])
            self.assertIn("ROI_CANDIDATE_VALID=True", output.getvalue())
            self.assertTrue(layer.visible)
            self.assertEqual(source.read_bytes(), before)

    def test_rejects_roi_wrong_size(self):
        original = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
        with self.assertRaisesRegex(ValueError, "dimensions"):
            patch_matches_full(
                original, original,
                Image.new("RGBA", (2, 1), (0, 0, 0, 0)),
                (1, 1, 2, 2),
            )


if __name__ == "__main__":
    unittest.main()
