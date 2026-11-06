"""Nonflaky performance guards for the F-10 zero-loss fast paths.

Wall-clock benchmarking is separate (verification.prores_performance); CI
asserts that the costly operations are avoided when their work is provably
redundant, not an unreliable timing target on shared runners.
"""

from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from tachie_motion.render import block_integrity
from tachie_motion.render.frame_validation import verify_decoded_frames
from tachie_motion.render.prores import encode_prores, read_rgba_states


class F10FastPathTests(unittest.TestCase):
    def test_uniform_frame_wide_error_below_threshold_skips_full_scan(self):
        error = Image.new("L", (1654, 2030), 16)
        with patch.object(
            block_integrity.np, "cumsum",
            side_effect=AssertionError("Unexpected expensive area scan"),
        ):
            self.assertEqual(
                block_integrity._max_area_mean(error, threshold=18),
                0.0,
            )

    def test_moderate_damage_above_threshold_still_uses_exact_scan(self):
        error = Image.new("L", (96, 96), 0)
        error.paste(40, (16, 16, 48, 48))
        with patch.object(
            block_integrity.np, "cumsum",
            wraps=block_integrity.np.cumsum,
        ) as sums:
            result = block_integrity._max_area_mean(error, threshold=18)
            self.assertGreater(result, 18)
            self.assertGreaterEqual(sums.call_count, 2)

    def test_widespread_bounded_color_and_alpha_are_accepted(self):
        expected = Image.new("RGBA", (256, 256), (80, 100, 120, 255))
        actual = Image.new("RGBA", (256, 256), (96, 116, 136, 239))
        self.assertEqual(
            block_integrity.check_frame_blocks(actual, expected, frame_index=1),
            (0, 0),
        )


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "FFmpeg and ffprobe needed to verify decoded frame reuse",
)
class FrameReuseTests(unittest.TestCase):
    def test_identical_frames_reuse_fidelity_only_with_same_expected_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pngs = [root / "a.png", root / "b.png"]
            for path, color in zip(
                pngs, ((255, 0, 0, 255), (0, 0, 255, 255))
            ):
                img = Image.new("RGBA", (128, 128))
                img.paste(color, (20, 20, 108, 108))
                img.save(path)
            mov = root / "30frames.mov"
            encode_prores(pngs, mov, fps=30, frames_per_state=15)
            dims, states = read_rgba_states(pngs)
            real_checker = block_integrity.check_frame_blocks
            with patch(
                "tachie_motion.render.frame_validation.check_frame_blocks",
                wraps=real_checker,
            ) as calls:
                result = verify_decoded_frames(
                    mov, dimensions=dims, count=30, ffmpeg="ffmpeg",
                    source_states=states, frames_per_state=15,
                )
                self.assertEqual(result[0], 30)
                # Compression output is byte-identical for each repeated
                # ProRes intra-frame; one full check per distinct source state.
                self.assertEqual(calls.call_count, 2)

    def test_identical_bytes_with_different_expected_states_are_rechecked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
            img.paste((255, 10, 20, 255), (10, 10, 54, 54))
            paths = [root / "a.png", root / "b.png"]
            for p in paths:
                img.save(p)
            mov = root / "repeated.mov"
            encode_prores(paths, mov, fps=30, frames_per_state=2)
            dims, states = read_rgba_states(paths)
            real_checker = block_integrity.check_frame_blocks
            with patch(
                "tachie_motion.render.frame_validation.check_frame_blocks",
                wraps=real_checker,
            ) as calls:
                result = verify_decoded_frames(
                    mov, dimensions=dims, count=4, ffmpeg="ffmpeg",
                    source_states=states, frames_per_state=2,
                )
                self.assertEqual(result[0], 4)
                self.assertEqual(calls.call_count, 2)


if __name__ == "__main__":
    unittest.main()
