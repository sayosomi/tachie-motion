"""Synthetic tests for fixed crops across independent PSD visibility states."""

from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

from tachie_motion.psd.crop import write_fixed_crop_png
from tachie_motion.psd.variant_cli import main as variant_main
from tachie_motion.psd.visibility import apply_visibility


class FakeLayer:
    def __init__(self, bbox, *, visible=True):
        self.bbox = bbox
        self.visible = visible
        self.name = "shape"

    def is_group(self):
        return False


class FakePSD:
    width = 20
    height = 12

    def __init__(self):
        self.layers = [
            FakeLayer((4, 3, 10, 9), visible=True),
            FakeLayer((1, 2, 16, 10), visible=False),
        ]
        self.extra_opaque_pixel = None

    def __iter__(self):
        return iter(self.layers)

    def __len__(self):
        return len(self.layers)

    def __getitem__(self, index):
        return self.layers[index]

    def composite(self, **kwargs):
        image = Image.new("RGBA", (self.width, self.height))
        draw = ImageDraw.Draw(image)
        for index, layer in enumerate(self.layers):
            if layer.visible:
                x0, y0, x1, y1 = layer.bbox
                draw.rectangle(
                    (x0, y0, x1 - 1, y1 - 1),
                    fill=(255, 0, 0, 255) if index == 0 else (0, 0, 255, 255),
                )
        if self.extra_opaque_pixel is not None:
            image.putpixel(self.extra_opaque_pixel, (0, 255, 0, 1))
        return image


class FixedCropTests(unittest.TestCase):
    def test_base_and_hidden_alternative_share_bounds_and_origin(self):
        psd = FakePSD()
        with tempfile.TemporaryDirectory() as folder:
            original = Path(folder) / "original.png"
            alternate = Path(folder) / "alternate.png"
            base = write_fixed_crop_png(psd, original, padding=1)
            apply_visibility(psd, show=["1"], hide=["0"])
            changed = write_fixed_crop_png(psd, alternate, padding=1)

            self.assertEqual(base.bounds.box, (0, 1, 18, 11))
            self.assertEqual(base.bounds.box, changed.bounds.box)
            self.assertEqual(base.bounds.origin, changed.bounds.origin)
            self.assertEqual(base.alpha_box, (4, 3, 10, 9))
            self.assertEqual(changed.alpha_box, (1, 2, 16, 10))
            with Image.open(original) as a, Image.open(alternate) as b:
                self.assertEqual(a.size, (18, 10))
                self.assertEqual(b.size, a.size)
                self.assertEqual(a.getpixel((4, 2)), (255, 0, 0, 255))
                self.assertEqual(b.getpixel((4, 2)), (0, 0, 255, 255))

    def test_odd_canvas_width_pads_transparent_right_without_shift(self):
        class OddCanvasPSD(FakePSD):
            width = 19

        psd = OddCanvasPSD()
        # Full-width content; even sizing must add one transparent column
        # beyond the original canvas without shifting the anchor.
        psd.layers = [FakeLayer((0, 0, 19, 12), visible=True)]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "odd.png"
            report = write_fixed_crop_png(psd, path, padding=0)
            self.assertEqual(report.bounds.box, (0, 0, 20, 12))
            self.assertEqual(report.bounds.origin, (0, 0))
            with Image.open(path) as image:
                self.assertEqual(image.size, (20, 12))
                self.assertEqual(image.getpixel((19, 5))[3], 0)

    def test_odd_canvas_height_pads_transparent_bottom_without_shift(self):
        class OddCanvasPSD(FakePSD):
            height = 11

        psd = OddCanvasPSD()
        psd.layers = [FakeLayer((0, 0, 20, 11), visible=True)]
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "height-padded.png"
            report = write_fixed_crop_png(psd, output, padding=0)
            self.assertEqual(report.bounds.box, (0, 0, 20, 12))
            self.assertEqual(report.bounds.origin, (0, 0))
            with Image.open(output) as image:
                self.assertEqual(image.size, (20, 12))
                self.assertEqual(image.getpixel((10, 10))[3], 255)
                self.assertEqual(image.getpixel((10, 11)), (0, 0, 0, 0))

    def test_rejects_alpha_outside_box_before_writing_file(self):
        psd = FakePSD()
        psd.extra_opaque_pixel = (18, 0)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "should-not-exist.png"
            with self.assertRaisesRegex(RuntimeError, "extend beyond fixed crop"):
                write_fixed_crop_png(psd, path, padding=1)
            self.assertFalse(path.exists())

    def test_base_crop_without_explicit_changes_is_allowed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            psd_path = root / "test.psd"
            psd_path.write_bytes(b"fake")
            destination = root / "base.png"
            with patch(
                "tachie_motion.psd.variant_cli.PSDImage.open",
                return_value=FakePSD(),
            ), redirect_stdout(StringIO()) as printed:
                result = variant_main(
                    [
                        str(psd_path),
                        "--fixed-crop",
                        "--padding",
                        "1",
                        "--output",
                        str(destination),
                    ]
                )
            self.assertEqual(result, 0)
            self.assertIn("Alpha containment check: PASS", printed.getvalue())
            self.assertTrue(destination.is_file())

    def test_cli_manual_variant_keeps_same_dimensions(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            psd_path = root / "test.psd"
            psd_path.write_bytes(b"fake")
            destination = root / "changed.png"
            fake = FakePSD()
            with patch(
                "tachie_motion.psd.variant_cli.PSDImage.open",
                return_value=fake,
            ), redirect_stdout(StringIO()):
                result = variant_main(
                    [
                        str(psd_path),
                        "--show", "1", "--hide", "0",
                        "--fixed-crop", "--padding", "1",
                        "--output", str(destination),
                    ]
                )
            self.assertEqual(result, 0)
            self.assertFalse(fake[0].visible)
            self.assertTrue(fake[1].visible)
            with Image.open(destination) as image:
                self.assertEqual(image.size, (18, 10))


if __name__ == "__main__":
    unittest.main()
