"""Characterize a real layered PSD with multiply blending.

This tests a representative non-normal mode; it is NOT proof that arbitrary
Photoshop effects/masks/adjustments reproduce faithfully.
"""

from pathlib import Path
import tempfile
import unittest

from PIL import Image
from psd_tools import PSDImage
from psd_tools.constants import BlendMode

from tachie_motion.psd.fidelity import find_fidelity_risks
from tachie_motion.psd.raster import composite_rgba


class ComplexPsdIntegration(unittest.TestCase):
    def test_multiply_layer_is_preserved_and_reported_after_psd_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "multiply.psd"
            doc = PSDImage.new(mode="RGB", size=(32, 32), depth=8)
            doc.create_pixel_layer(
                Image.new("RGBA", (16, 16), (128, 128, 128, 255)),
                name="base", top=8, left=8,
            )
            blend = doc.create_pixel_layer(
                Image.new("RGBA", (16, 16), (255, 0, 0, 255)),
                name="red-multiply", top=8, left=8,
            )
            blend.blend_mode = BlendMode.MULTIPLY
            doc.save(source)

            opened = PSDImage.open(source)
            warnings = list(find_fidelity_risks(opened))
            self.assertTrue(
                any(warning.feature == "blend-mode" for warning in warnings),
                "Diagnostics must flag non-normal PSD blending",
            )
            layer = next(
                layer for layer in opened if layer.name == "red-multiply"
            )
            self.assertEqual(layer.blend_mode, BlendMode.MULTIPLY)
            self.assertEqual(composite_rgba(opened).size, (32, 32))


if __name__ == "__main__":
    unittest.main()
