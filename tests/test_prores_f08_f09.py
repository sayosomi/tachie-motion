"""Independent F-08/F-09 regression cases and live ProRes negative controls."""

from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageChops, ImageDraw, ImageStat

from tachie_motion.render.block_integrity import check_frame_blocks
from tachie_motion.render.probe import inspect_prores
from tachie_motion.render.prores import encode_prores, read_rgba_states


def scene(*, mouth="red", line_damage=None, panel_rgb=255, panel_alpha=120):
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    brush = ImageDraw.Draw(image)
    brush.rectangle((20, 20, 490, 490), fill=(130, 140, 150, 255))
    brush.rectangle(
        (250, 350, 270, 369),
        fill=(255, 0, 0, 255) if mouth == "red"
        else (0, 0, 255, 255),
    )
    brush.rectangle(
        (350, 100, 449, 199),
        fill=(panel_rgb, panel_rgb, panel_rgb, panel_alpha),
    )
    # Static black line: not part of mouth's source-state change mask.
    brush.line((80, 280, 115, 280), fill=(0, 0, 0, 255), width=1)
    if line_damage is not None:
        axis, start = line_damage
        if axis == "x":
            for x in range(start, start + 8):
                image.putpixel((x, 280), (0, 0, 0, 0))
        else:
            # Alternative 8px vertical line, also unchanged by the mouth.
            for y in range(280, 288):
                image.putpixel((80, y), (0, 0, 0, 0))
    return image


class SlidingWindowBoundaryTests(unittest.TestCase):
    def test_f08_every_x_offset_catches_eight_contiguous_alpha_pixels(self):
        expected = Image.new("RGBA", (64, 64), (20, 30, 40, 255))
        for offset in range(8):
            with self.subTest(offset=offset):
                actual = expected.copy()
                for x in range(16 + offset, 24 + offset):
                    actual.putpixel((x, 20), (0, 0, 0, 0))
                self.assertLess(
                    ImageStat.Stat(
                        ImageChops.difference(
                            expected.getchannel("A"), actual.getchannel("A")
                        )
                    ).mean[0], 3.0,
                )
                with self.assertRaisesRegex(RuntimeError, "global block alpha"):
                    check_frame_blocks(actual, expected, frame_index=1)

    def test_f08_every_y_offset_catches_eight_contiguous_alpha_pixels(self):
        expected = Image.new("RGBA", (64, 64), (20, 30, 40, 255))
        for offset in range(8):
            with self.subTest(offset=offset):
                actual = expected.copy()
                for y in range(16 + offset, 24 + offset):
                    actual.putpixel((20, y), (0, 0, 0, 0))
                with self.assertRaisesRegex(RuntimeError, "global block alpha"):
                    check_frame_blocks(actual, expected, frame_index=1)

    def test_f08_catches_all_x_y_phase_offsets_for_eight_pixel_line(self):
        expected = Image.new("RGBA", (64, 64), (30, 50, 70, 255))
        for dx in range(8):
            for dy in range(8):
                with self.subTest(dx=dx, dy=dy):
                    actual = expected.copy()
                    for x in range(16 + dx, 24 + dx):
                        actual.putpixel((x, 16 + dy), (255, 0, 0, 255))
                    with self.assertRaisesRegex(RuntimeError, "global block RGB"):
                        check_frame_blocks(actual, expected, frame_index=0)

    def test_isolated_artifacts_still_allowed(self):
        expected = Image.new("RGBA", (64, 64), (30, 50, 70, 255))
        actual = expected.copy()
        for x in (18, 19):
            actual.putpixel((x, 22), (255, 0, 0, 255))
        self.assertEqual(check_frame_blocks(actual, expected, frame_index=0), (0, 2))


class TranslucentAreaTests(unittest.TestCase):
    def test_f09_unchanged_alpha120_panel_rgb255_to160_is_rejected(self):
        correct = scene(mouth="blue")
        damaged = scene(mouth="blue", panel_rgb=160)
        self.assertEqual(
            ImageChops.difference(
                correct.getchannel("A"), damaged.getchannel("A")
            ).getbbox(), None,
        )
        self.assertEqual(check_frame_blocks(correct, correct, frame_index=1), (0, 0))
        with self.assertRaisesRegex(RuntimeError, "global area RGB"):
            check_frame_blocks(damaged, correct, frame_index=1)

    def test_f09_unchanged_panel_alpha120_to80_is_rejected(self):
        correct = scene(mouth="blue")
        damaged = scene(mouth="blue", panel_alpha=80)
        self.assertLess(
            ImageStat.Stat(ImageChops.difference(
                correct.getchannel("A"), damaged.getchannel("A")
            )).mean[0], 3.0,
        )
        self.assertEqual(check_frame_blocks(correct, correct, frame_index=1), (0, 0))
        with self.assertRaisesRegex(RuntimeError, "global area alpha"):
            check_frame_blocks(damaged, correct, frame_index=1)

    def test_f09_tiny_normal_quantization_difference_is_allowed(self):
        correct = scene(mouth="blue")
        noisy = scene(mouth="blue", panel_rgb=253, panel_alpha=119)
        self.assertEqual(
            check_frame_blocks(noisy, correct, frame_index=1), (0, 0)
        )


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "FFmpeg and ffprobe are required for real ProRes negative controls",
)
class RealProresF08F09Tests(unittest.TestCase):
    def negative_mov(self, correct, broken, diagnostic):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            before = scene(mouth="red")
            first, intended, damaged = (
                root / "first.png", root / "expected.png", root / "wrong.png"
            )
            before.save(first)
            correct.save(intended)
            broken.save(damaged)
            good_mov, wrong_mov = root / "good.mov", root / "wrong.mov"
            good_report = encode_prores(
                [first, intended], good_mov, fps=30, frames_per_state=1
            )
            self.assertEqual(good_report.decoded_frames, 2)
            encode_prores(
                [first, damaged], wrong_mov, fps=30, frames_per_state=1
            )
            size, states = read_rgba_states([first, intended])
            # The new frame-wide gate is the *necessary* cause of rejection:
            # disabling it silently accepts this damaged MOV (mutation FAIL).
            with patch(
                "tachie_motion.render.frame_validation.check_frame_blocks",
                return_value=(0, 0),
            ):
                unchecked = inspect_prores(
                    wrong_mov, expected_size=size, expected_frames=2,
                    expected_fps=30, source_states=states, frames_per_state=1,
                )
                self.assertEqual(unchecked.decoded_frames, 2)
            # For F-09 prove the *area* gate works independently, even
            # when the severe-error block gate is suppressed. Real FFmpeg
            # quantization may push a few RGB values above 96, so the
            # strong-error gate can legitimately detect F-09 first.
            if diagnostic.startswith("global area"):
                with patch(
                    "tachie_motion.render.block_integrity._max_bad_pixels_per_block",
                    return_value=0,
                ):
                    with self.assertRaisesRegex(RuntimeError, diagnostic):
                        inspect_prores(
                            wrong_mov, expected_size=size, expected_frames=2,
                            expected_fps=30, source_states=states,
                            frames_per_state=1,
                        )
            # With all gates restored, require the correct damaged channel
            # to be rejected by either independent spatial detector.
            channel = "RGB" if "RGB" in diagnostic else "alpha"
            with self.assertRaisesRegex(
                RuntimeError, f"global (?:block|area) {channel}"
            ):
                inspect_prores(
                    wrong_mov, expected_size=size, expected_frames=2,
                    expected_fps=30, source_states=states, frames_per_state=1,
                )

    def test_f08_prores_eight_pixel_line_at_offset_two(self):
        self.negative_mov(
            scene(mouth="blue"),
            scene(mouth="blue", line_damage=("x", 82)),
            "global block alpha",
        )

    def test_f09_prores_invariant_panel_rgb_moderate_change(self):
        self.negative_mov(
            scene(mouth="blue"),
            scene(mouth="blue", panel_rgb=160),
            "global area RGB",
        )

    def test_f09_prores_invariant_panel_alpha_moderate_change(self):
        self.negative_mov(
            scene(mouth="blue"),
            scene(mouth="blue", panel_alpha=80),
            "global area alpha",
        )


if __name__ == "__main__":
    unittest.main()
