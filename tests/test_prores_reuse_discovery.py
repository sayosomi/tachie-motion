"""Issue #8: synthetic full-fidelity proof for the disposable reuse benchmark."""

from pathlib import Path
import shutil
import tempfile
import unittest

from PIL import Image, ImageDraw

from tachie_motion.render.prores import read_rgba_states
from verification.prores_reuse_discovery import (
    _encode_reused, _encode_standard, _packet_hashes, _verify,
)


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "FFmpeg/FFprobe required for packet reuse discovery",
)
class RepeatedPacketDiscoveryTests(unittest.TestCase):
    def test_2_states_3_holds_identical_prores_payloads_and_full_fidelity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs = []
            for i, col in enumerate(((150, 90, 75, 255), (75, 90, 150, 255))):
                image = Image.new("RGBA", (48, 48), (0, 0, 0, 0))
                ImageDraw.Draw(image).rectangle((6, 6, 41, 41), fill=col)
                path = root / f"frame_{i}.png"
                image.save(path)
                inputs.append(path)
            dims, images = read_rgba_states(inputs)
            for fps in (24, 30, 60):
                with self.subTest(fps=fps):
                    out = root / f"normal_{fps}.mov"
                    alt = root / f"reuse_{fps}.mov"
                    staging = root / f"staging_{fps}"
                    staging.mkdir()
                    _encode_standard(
                        images, dims, fps=fps, hold=3, output=out
                    )
                    _encode_reused(
                        images, dims, fps=fps, hold=3,
                        output=alt, staging=staging,
                    )
                    t1, rep1 = _verify(
                        out, dims, images, fps=fps, hold=3
                    )
                    t2, rep2 = _verify(
                        alt, dims, images, fps=fps, hold=3
                    )
                    self.assertEqual(rep1, rep2)
                    self.assertEqual(rep1["decoded_frames"], 6)
                    self.assertEqual(
                        _packet_hashes(out, fps, 6),
                        _packet_hashes(alt, fps, 6),
                    )
                    self.assertGreaterEqual(t1, 0)
                    self.assertGreaterEqual(t2, 0)


if __name__ == "__main__":
    unittest.main()
