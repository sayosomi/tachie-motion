"""Synthetic RGB/alpha regression tests for FFmpeg ProRes 4444 PoC."""

from pathlib import Path
import shutil
import tempfile
import unittest

from PIL import Image, ImageDraw

from tachie_motion.render.probe import inspect_prores
from tachie_motion.render.prores import (
    encode_prores,
    ffmpeg_args,
    read_rgba_states,
)


class ProresValidationTests(unittest.TestCase):
    def test_explicit_encoder_profile_alpha_and_integer_frame_count(self):
        args = ffmpeg_args(
            ffmpeg="ffmpeg",
            dimensions=(32, 24),
            fps=30,
            frame_count=12,
            output=Path("out.mov"),
        )
        for option, expected in (
            ("-c:v", "prores_ks"),
            ("-profile:v", "4444"),
            ("-pix_fmt", "yuva444p10le"),
            ("-alpha_bits", "16"),
            ("-frames:v", "12"),
        ):
            self.assertEqual(args[args.index(option) + 1], expected)
        self.assertIn("pipe:0", args)
        with self.assertRaisesRegex(ValueError, "fps"):
            ffmpeg_args(
                ffmpeg="ffmpeg", dimensions=(32, 24),
                fps=25, frame_count=12, output=Path("out.mov"),
            )

    def test_rejects_size_mismatch_and_no_alpha(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            a, b, rgb = (
                folder / "a.png", folder / "b.png", folder / "rgb.png"
            )
            Image.new("RGBA", (32, 24), (0, 0, 0, 0)).save(a)
            Image.new("RGBA", (40, 24), (0, 0, 0, 0)).save(b)
            Image.new("RGB", (32, 24), (255, 0, 0)).save(rgb)
            with self.assertRaisesRegex(ValueError, "identical dimensions"):
                read_rgba_states((a, b))
            with self.assertRaisesRegex(ValueError, "no alpha"):
                read_rgba_states((a, rgb))
            with self.assertRaisesRegex(ValueError, "at least two"):
                read_rgba_states((a,))
            self.assertEqual(read_rgba_states((a, a))[0], (32, 24))

    def test_rejects_opaque_alpha_and_odd_width(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            opaque, odd = folder / "opaque.png", folder / "odd.png"
            odd_height = folder / "odd-height.png"
            Image.new("RGBA", (32, 24), (0, 0, 0, 255)).save(opaque)
            Image.new("RGBA", (31, 24), (0, 0, 0, 0)).save(odd)
            Image.new("RGBA", (32, 25), (0, 0, 0, 0)).save(odd_height)
            with self.assertRaisesRegex(ValueError, "fully opaque"):
                read_rgba_states((opaque, opaque))
            with self.assertRaisesRegex(ValueError, "even image width"):
                read_rgba_states((odd, odd))
            with self.assertRaisesRegex(ValueError, "even image height"):
                read_rgba_states((odd_height, odd_height))


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "FFmpeg and ffprobe required for encoder integration test",
)
class ProresIntegrationTests(unittest.TestCase):
    def test_short_mov_profile_count_and_decoded_alpha(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            source1 = folder / "closed.png"
            source2 = folder / "open.png"
            for path, color in (
                (source1, (255, 30, 15, 255)),
                (source2, (20, 45, 255, 255)),
            ):
                image = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
                draw = ImageDraw.Draw(image)
                draw.rectangle((7, 8, 25, 23), fill=color)
                image.save(path)
            output = folder / "sample.mov"
            report = encode_prores(
                [source1, source2], output, fps=30, frames_per_state=2
            )
            self.assertTrue(output.exists())
            self.assertEqual(report.codec, "prores")
            self.assertIn("4444", report.profile)
            self.assertTrue(report.pixel_format.startswith("yuva444p"))
            self.assertEqual((report.width, report.height), (32, 32))
            self.assertEqual(report.frames, 4)
            self.assertEqual(report.decoded_frames, 4)
            self.assertLess(report.max_alpha_mean_error, 3)
            self.assertLess(report.max_rgb_mean_error, 20)
            self.assertLess(report.alpha_min, 255)
            self.assertGreater(report.alpha_max, 0)
            dimensions, frames = read_rgba_states([source1, source2])
            with self.assertRaisesRegex(RuntimeError, "RGB content mismatch"):
                inspect_prores(
                    output, expected_size=dimensions,
                    expected_frames=4, expected_fps=30,
                    source_states=list(reversed(frames)), frames_per_state=2,
                )
            with self.assertRaises(FileExistsError):
                encode_prores(
                    [source1, source2], output, fps=30, frames_per_state=2
                )


if __name__ == "__main__":
    unittest.main()
