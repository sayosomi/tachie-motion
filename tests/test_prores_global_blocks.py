"""F-06-A/B and F-07-A/B: full-frame small-defect regression tests.

Each negative control is tested both in memory and after a real ProRes 4444
encode/decode. The latter encodes the *wrong* frames against their own source
to produce a valid MOV, then independently validates against the *intended*
frames to prove the integrity gate rejects the corruption.
"""

from pathlib import Path
import shutil
import tempfile
import unittest

from PIL import Image, ImageChops, ImageDraw, ImageStat

from tachie_motion.render.block_integrity import check_frame_blocks
from tachie_motion.render.probe import inspect_prores
from tachie_motion.render.prores import encode_prores, read_rgba_states


def draw_scene(
    *,
    mouth: str = "red",
    mouth_alpha: int = 255,
    panel: str = "white",
    outline: str = "normal",
) -> Image.Image:
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((30, 30, 480, 480), fill=(120, 150, 170, 255))
    draw.rectangle(
        (240, 300, 259, 319),
        fill=(255, 0, 0, mouth_alpha) if mouth == "red"
        else (0, 0, 255, mouth_alpha),
    )
    if panel != "none":
        color = (255, 255, 255, 120) if panel == "white" else (0, 0, 0, 120)
        draw.rectangle((350, 100, 449, 199), fill=color)
    if outline != "none":
        draw.rectangle((240, 300, 241, 319), fill=(0, 0, 0, 255))
        if outline == "missing":
            draw.rectangle((240, 300, 241, 319), fill=(0, 0, 0, 0))
    return image


def draw_boundary_scene(*, mouth: str, missing_stripe: bool = False) -> Image.Image:
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((30, 30, 480, 480), fill=(120, 150, 170, 255))
    draw.rectangle(
        (80, 80, 89, 89),
        fill=(255, 0, 0, 255) if mouth == "red" else (0, 0, 255, 255),
    )
    draw.rectangle(
        (59, 80, 59, 99),
        fill=(0, 0, 0, 0) if missing_stripe else (0, 0, 0, 255),
    )
    return image


class BlockIntegrityTests(unittest.TestCase):
    def test_f06a_invariant_translucent_panel_rgb_is_checked(self):
        first = draw_scene(mouth="red")
        second = draw_scene(mouth="blue")
        corrupted = draw_scene(mouth="blue", panel="black")
        self.assertEqual(
            ImageChops.difference(
                second.getchannel("A"), corrupted.getchannel("A")
            ).getbbox(), None
        )
        self.assertEqual(check_frame_blocks(second, second, frame_index=1), (0, 0))
        with self.assertRaisesRegex(RuntimeError, "global block RGB"):
            check_frame_blocks(corrupted, second, frame_index=1)

    def test_f06b_low_alpha_red_to_blue_all_values(self):
        for alpha in (7, 10, 16, 20, 120):
            with self.subTest(alpha=alpha):
                before = draw_scene(mouth="red", mouth_alpha=alpha, panel="none")
                expected = draw_scene(mouth="blue", mouth_alpha=alpha, panel="none")
                self.assertEqual(
                    before.getpixel((250, 310))[3], alpha
                )
                self.assertEqual(
                    check_frame_blocks(expected, expected, frame_index=1),
                    (0, 0),
                )
                with self.assertRaisesRegex(RuntimeError, "global block RGB"):
                    check_frame_blocks(before, expected, frame_index=1)

    def test_f07a_40_pixel_invariant_outline_is_checked(self):
        expected = draw_scene(mouth="blue", panel="none")
        damaged = draw_scene(mouth="blue", panel="none", outline="missing")
        alpha_diff = ImageChops.difference(
            expected.getchannel("A"), damaged.getchannel("A")
        )
        self.assertEqual(alpha_diff.histogram()[255], 40)
        self.assertLess(ImageStat.Stat(alpha_diff).mean[0], 3)
        with self.assertRaisesRegex(RuntimeError, "global block alpha"):
            check_frame_blocks(damaged, expected, frame_index=1)

    def test_f07b_stripe_five_pixels_beyond_change_halo_is_checked(self):
        expected = draw_boundary_scene(mouth="blue")
        damaged = draw_boundary_scene(mouth="blue", missing_stripe=True)
        # The changed mouth begins in the 64..95 source-change tile,
        # whose four-pixel halo begins at x=60, while x=59 is outside.
        with self.assertRaisesRegex(RuntimeError, "global block alpha"):
            check_frame_blocks(damaged, expected, frame_index=1)

    def test_block_gate_allows_isolated_codec_noise(self):
        original = draw_scene(mouth="blue")
        noisy = original.copy()
        noisy.putpixel((250, 310), (0, 255, 0, 255))
        noisy.putpixel((251, 310), (0, 255, 0, 255))
        peaks = check_frame_blocks(noisy, original, frame_index=0)
        self.assertLess(peaks[1], 8)

    def test_eight_bad_pixels_crossing_eight_pixel_seam_are_caught(self):
        expected = Image.new("RGBA", (64, 64), (80, 100, 120, 255))
        actual = expected.copy()
        # Without a phase-shifted grid, pixels x=4..11 are split across
        # two x=0..7 / x=8..15 cells, four errors in each (<8).
        for x in range(4, 12):
            actual.putpixel((x, 24), (255, 0, 0, 255))
        with self.assertRaisesRegex(RuntimeError, "global block RGB"):
            check_frame_blocks(actual, expected, frame_index=1)

    def test_invisible_rgb_is_not_compared(self):
        original = Image.new("RGBA", (64, 64), (255, 0, 0, 0))
        different = Image.new("RGBA", (64, 64), (0, 0, 255, 0))
        self.assertEqual(
            check_frame_blocks(different, original, frame_index=0), (0, 0)
        )


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "FFmpeg and ffprobe required for real ProRes negative controls",
)
class BlockIntegrityMovIntegrationTests(unittest.TestCase):
    def _test_negative(
        self, valid_first: Image.Image, valid_second: Image.Image,
        broken_second: Image.Image, message: str
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a, b, c = root / "a.png", root / "b.png", root / "broken.png"
            valid_first.save(a)
            valid_second.save(b)
            broken_second.save(c)
            # A normal MOV, validated with the new checker, should succeed.
            good = root / "good.mov"
            encode_prores([a, b], good, fps=30, frames_per_state=2)

            # Encode the damaged frames as the stream's intended contents,
            # so encoding succeeds; catch the mistake only at independent
            # verification against the actual source states.
            bad = root / "bad.mov"
            encode_prores([a, c], bad, fps=30, frames_per_state=2)
            dims, expected_states = read_rgba_states([a, b])
            with self.assertRaisesRegex(RuntimeError, message):
                inspect_prores(
                    bad, expected_size=dims, expected_frames=4,
                    expected_fps=30, source_states=expected_states,
                    frames_per_state=2,
                )

    def test_f06a_real_mov_invariant_translucent_panel(self):
        self._test_negative(
            draw_scene(mouth="red"),
            draw_scene(mouth="blue"),
            draw_scene(mouth="blue", panel="black"),
            "global block RGB",
        )

    def test_f06b_real_mov_alpha7_switch(self):
        self._test_negative(
            draw_scene(mouth="red", mouth_alpha=7, panel="none"),
            draw_scene(mouth="blue", mouth_alpha=7, panel="none"),
            draw_scene(mouth="red", mouth_alpha=7, panel="none"),
            "global block RGB",
        )

    def test_f06b_real_mov_alpha16_switch(self):
        self._test_negative(
            draw_scene(mouth="red", mouth_alpha=16, panel="none"),
            draw_scene(mouth="blue", mouth_alpha=16, panel="none"),
            draw_scene(mouth="red", mouth_alpha=16, panel="none"),
            "global block RGB",
        )

    def test_f07a_real_mov_40_pixel_contour(self):
        self._test_negative(
            draw_scene(mouth="red", panel="none"),
            draw_scene(mouth="blue", panel="none"),
            draw_scene(mouth="blue", panel="none", outline="missing"),
            "global block alpha",
        )

    def test_f07b_real_mov_stripe_outside_halo(self):
        self._test_negative(
            draw_boundary_scene(mouth="red"),
            draw_boundary_scene(mouth="blue"),
            draw_boundary_scene(mouth="blue", missing_stripe=True),
            "global block alpha",
        )


if __name__ == "__main__":
    unittest.main()
