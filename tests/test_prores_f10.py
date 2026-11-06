"""F-10: area MAE is invariant to 32px grid phases, with real ProRes proof.

The F-09 100px translucent panel covered a whole aligned tile, masking the
F-10 false negative: a 32px panel shifted by 16px in both directions had a
maximum aligned mean of only about one quarter of its actual mean.
"""

from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

from tachie_motion.render.block_integrity import (
    _max_area_mean,
    check_frame_blocks,
    _max_bad_pixels_per_block,
)
from tachie_motion.render.probe import inspect_prores
from tachie_motion.render.prores import encode_prores, read_rgba_states


def scene(*, mouth: str, panel_rgb: int = 255,
          panel_alpha: int = 120, panel_origin=(304, 112)):
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((30, 30, 480, 480), fill=(115, 140, 160, 255))
    draw.rectangle(
        (240, 300, 259, 319),
        fill=(255, 0, 0, 255) if mouth == "red"
        else (0, 0, 255, 255),
    )
    x, y = panel_origin
    draw.rectangle(
        (x, y, x + 31, y + 31),
        fill=(panel_rgb, panel_rgb, panel_rgb, panel_alpha),
    )
    return image


class ExactAreaWindowTests(unittest.TestCase):
    def test_f10_alpha_every_xy_phase_0_to_31(self):
        error = Image.new("L", (96, 96), 0)
        for dx in range(32):
            for dy in range(32):
                with self.subTest(dx=dx, dy=dy):
                    error.paste(0, (0, 0, 96, 96))
                    error.paste(40, (dx, dy, dx + 32, dy + 32))
                    peak = _max_area_mean(error, threshold=18)
                    self.assertGreater(peak, 18)
                    self.assertLessEqual(peak, 40.0)  # early exit at first >18

    def test_f10_rgb_every_xy_phase_0_to_31(self):
        error = Image.new("L", (96, 96), 0)
        for dx in range(32):
            for dy in range(32):
                with self.subTest(dx=dx, dy=dy):
                    error.paste(0, (0, 0, 96, 96))
                    error.paste(45, (dx, dy, dx + 32, dy + 32))
                    peak = _max_area_mean(error, threshold=18)
                    self.assertGreater(peak, 18)
                    self.assertLessEqual(peak, 45.0)  # early exit at first >18

    def test_f10_real_comparison_rgb_and_alpha_across_grid_boundary(self):
        expected = scene(mouth="blue", panel_origin=(304, 112))
        rgb_broken = scene(mouth="blue", panel_rgb=160,
                           panel_origin=(304, 112))
        alpha_broken = scene(mouth="blue", panel_alpha=80,
                             panel_origin=(304, 112))
        # Panel origin mod 32 == 16 on both axes; old fixed grid split
        # every damaged pixel equally among four tiles.
        self.assertEqual(304 % 32, 16)
        self.assertEqual(112 % 32, 16)
        self.assertEqual(check_frame_blocks(expected, expected, frame_index=1),
                         (0, 0))
        with self.assertRaisesRegex(RuntimeError, "global area RGB"):
            check_frame_blocks(rgb_broken, expected, frame_index=1)
        with self.assertRaisesRegex(RuntimeError, "global area alpha"):
            check_frame_blocks(alpha_broken, expected, frame_index=1)

    def test_f08_early_exit_reports_exact_occupancy_for_distant_pixels(self):
        mask = Image.new("L", (256, 256))
        mask.putpixel((2, 3), 255)
        mask.putpixel((202, 203), 255)
        self.assertEqual(_max_bad_pixels_per_block(mask, 8), 1)


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "FFmpeg and ffprobe required for F-10 real ProRes integration",
)
class ExactAreaProresTests(unittest.TestCase):
    def check_corrupt_mov(self, *, alpha: bool):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, correct, corrupted = [
                root / filename for filename in ("first.png", "correct.png", "wrong.png")
            ]
            scene(mouth="red").save(first)
            scene(mouth="blue").save(correct)
            scene(
                mouth="blue",
                panel_alpha=80 if alpha else 120,
                panel_rgb=255 if alpha else 160,
            ).save(corrupted)

            good_mov, wrong_mov = root / "good.mov", root / "wrong.mov"
            good_report = encode_prores(
                [first, correct], good_mov, fps=30, frames_per_state=1
            )
            self.assertEqual(good_report.decoded_frames, 2)
            bad_report = encode_prores(
                [first, corrupted], wrong_mov, fps=30, frames_per_state=1
            )
            self.assertEqual(bad_report.decoded_frames, 2)

            dims, expected_states = read_rgba_states([first, correct])
            kwargs = dict(
                expected_size=dims,
                expected_frames=2,
                expected_fps=30,
                source_states=expected_states,
                frames_per_state=1,
            )
            # Mutation: original F-10 false-negative if the whole-frame
            # detector is removed. Existing global averages and state-change
            # regions must not be sufficient to reject the damaged panel.
            with patch(
                "tachie_motion.render.frame_validation.check_frame_blocks",
                return_value=(0, 0),
            ):
                self.assertEqual(
                    inspect_prores(wrong_mov, **kwargs).decoded_frames, 2
                )

            # Independently test F-10 area logic by disabling ONLY the
            # severe-pixel detector. Damaged output must still fail.
            with patch(
                "tachie_motion.render.block_integrity._max_bad_pixels_per_block",
                return_value=0,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "global area alpha" if alpha else "global area RGB",
                ):
                    inspect_prores(wrong_mov, **kwargs)

                # Mutation: disable the new mean gate as well. Both
                # detectors disabled must accept the same MOV.
                with patch(
                    "tachie_motion.render.block_integrity._max_area_mean",
                    return_value=0.0,
                ):
                    self.assertEqual(
                        inspect_prores(wrong_mov, **kwargs).decoded_frames, 2
                    )
            # Restore all checks. The damaged channel must be rejected.
            with self.assertRaisesRegex(
                RuntimeError,
                r"global (?:block|area) " + ("alpha" if alpha else "RGB"),
            ):
                inspect_prores(wrong_mov, **kwargs)

    def test_f10_real_prores_boundary_rgb_255_to160(self):
        self.check_corrupt_mov(alpha=False)

    def test_f10_real_prores_boundary_alpha_120_to80(self):
        self.check_corrupt_mov(alpha=True)


if __name__ == "__main__":
    unittest.main()
