"""PoC tests for export paths and alpha-preserving compositing."""

import tempfile
import unittest
from pathlib import Path

from PIL import Image

from tachie_motion.psd.raster import write_comparison_images, write_layer_png


class FakePSD:
    width = 2
    height = 2

    def __init__(self, preview):
        self.preview = preview
        self.composite_options = None

    def topil(self):
        return self.preview

    def composite(self, **kwargs):
        self.composite_options = kwargs
        image = Image.new("RGBA", (2, 2), (0, 0, 0, 0))
        image.putpixel((1, 1), (255, 0, 0, 200))
        return image


class PSDRasterTests(unittest.TestCase):
    def test_writes_preview_and_transparent_composite(self):
        psd = FakePSD(Image.new("RGB", (2, 2), "white"))
        with tempfile.TemporaryDirectory() as folder:
            paths = write_comparison_images(psd, Path(folder))
            self.assertEqual(set(paths), {"embedded", "layers"})
            with Image.open(paths["layers"]) as image:
                self.assertEqual(image.mode, "RGBA")
                self.assertEqual(image.size, (2, 2))
                self.assertEqual(image.getpixel((0, 0))[3], 0)
                self.assertEqual(image.getpixel((1, 1))[3], 200)
            self.assertTrue(paths["embedded"].exists())
        self.assertEqual(
            psd.composite_options,
            {
                "viewport": (0, 0, 2, 2),
                "force": True,
                "ignore_preview": True,
                "alpha": 0.0,
            },
        )

    def test_handles_psd_with_no_embedded_preview(self):
        psd = FakePSD(None)
        with tempfile.TemporaryDirectory() as folder:
            paths = write_comparison_images(psd, Path(folder))
            self.assertEqual(set(paths), {"layers"})

    def test_variant_png_uses_full_canvas(self):
        psd = FakePSD(None)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "variants" / "closed-mouth.png"
            self.assertEqual(write_layer_png(psd, path), path)
            with Image.open(path) as image:
                self.assertEqual(image.size, (2, 2))
                self.assertEqual(image.getpixel((0, 0))[3], 0)


if __name__ == "__main__":
    unittest.main()
