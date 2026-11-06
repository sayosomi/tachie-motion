"""Integration tests with a generated, license-free layered PSD on disk.

Unlike fake-layer tests, this exercises psd-tools PSD save/open, group
traversal, visibility toggles and alpha compositing with real PSD pixels.
"""

import hashlib
from pathlib import Path
import tempfile
import unittest

from PIL import Image
from psd_tools import PSDImage

from tachie_motion.psd.bounds import compute_fixed_bounds, leaf_bboxes
from tachie_motion.psd.crop import write_fixed_crop_png
from tachie_motion.psd.raster import composite_rgba
from tachie_motion.psd.tree import walk_layers
from tachie_motion.psd.visibility import apply_visibility


class ActualPsdIntegrationTests(unittest.TestCase):
    def test_original_psd_remains_unchanged_after_toggling(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "synthetic.psd"
            psd = PSDImage.new(mode="RGB", size=(64, 64), depth=8)
            # The psd-tools PSD *writer* stores legacy Pascal names in
            # MacRoman. Use ASCII for this generated fixture; Japanese PSD
            # *reader* support was separately verified with real user media.
            group = psd.create_group(name="face-group")
            first = group.create_pixel_layer(
                Image.new("RGBA", (8, 8), (255, 0, 0, 255)),
                name="mouth", top=8, left=8,
            )
            second = group.create_pixel_layer(
                Image.new("RGBA", (10, 10), (0, 0, 255, 255)),
                name="mouth", top=30, left=30,
            )
            first.visible = True
            second.visible = False
            psd.save(source)

            original_sha = hashlib.sha256(source.read_bytes()).hexdigest()
            opened = PSDImage.open(source)
            entries = list(walk_layers(opened))
            self.assertEqual(len(entries), 3)
            self.assertEqual([entry.name for entry in entries].count("mouth"), 2)
            self.assertEqual(len({entry.index_path for entry in entries}), 3)

            pixel_entries = [item for item in entries if item.kind == "pixel"]
            self.assertEqual(len(pixel_entries), 2)
            shown = next(item for item in pixel_entries if item.visible)
            hidden = next(item for item in pixel_entries if not item.visible)
            self.assertEqual(shown.bbox, (8, 8, 16, 16))
            self.assertEqual(hidden.bbox, (30, 30, 40, 40))
            bounds = compute_fixed_bounds(
                leaf_bboxes(opened),
                canvas_width=opened.width,
                canvas_height=opened.height,
                padding=2,
            )
            self.assertEqual(bounds.box, (6, 6, 42, 42))
            self.assertEqual(bounds.origin, (6, 6))

            original_image = composite_rgba(opened)
            original_crop = directory / "base.png"
            base_report = write_fixed_crop_png(opened, original_crop, padding=2)

            show_path = "/".join(map(str, hidden.index_path))
            hide_path = "/".join(map(str, shown.index_path))
            apply_visibility(opened, show=[show_path], hide=[hide_path])
            changed_image = composite_rgba(opened)
            alternate_crop = directory / "alternate.png"
            alternate_report = write_fixed_crop_png(
                opened, alternate_crop, padding=2
            )

            self.assertEqual(base_report.bounds.box, alternate_report.bounds.box)
            self.assertEqual(base_report.bounds.origin, alternate_report.bounds.origin)
            self.assertEqual(original_image.getpixel((10, 10))[3], 255)
            self.assertEqual(original_image.getpixel((35, 35))[3], 0)
            self.assertEqual(changed_image.getpixel((10, 10))[3], 0)
            self.assertEqual(changed_image.getpixel((35, 35))[3], 255)
            with Image.open(original_crop) as a, Image.open(alternate_crop) as b:
                self.assertEqual(a.size, (36, 36))
                self.assertEqual(b.size, a.size)

            final_sha = hashlib.sha256(source.read_bytes()).hexdigest()
            self.assertEqual(original_sha, final_sha)


if __name__ == "__main__":
    unittest.main()
