"""Synthetic PNG/OTIO probe tests; no PSD, WAV, or MOV are used."""

import json
from fractions import Fraction
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from tachie_motion.timeline.still_probe import (
    build_still_timeline, create_synthetic_png, generate_probes,
)
from tachie_motion.timeline.still_timing import wait_frames


class StillProbeTests(unittest.TestCase):
    def test_all_fps_fractional_rounding_and_repeated_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = generate_probes(root)
            self.assertEqual(len(results), 13)
            image = root / "合成 立ち絵 e\u0301.png"
            original = image.read_bytes()
            expected = {
                24: (48, 24, 25, 24),
                30: (60, 30, 31, 31),
                60: (120, 61, 62, 61),
            }
            for fps, durations in expected.items():
                for label, frames in zip(
                    ("2s", "1p02s_floor", "1p02s_ceil", "1p02s_nearest"), durations, strict=True
                ):
                    document = json.loads(
                        (root / f"still_{fps}fps_{label}.otio").read_text("utf-8")
                    )
                    video, audio = document["tracks"]["children"]
                    clip = video["children"][0]
                    reference = clip["media_references"]["DEFAULT_MEDIA"]
                    self.assertEqual(reference["target_url"], str(image.resolve()))
                    self.assertEqual(reference["name"], image.name)
                    self.assertEqual(reference["available_range"]["duration"]["value"], 1)
                    self.assertEqual(clip["source_range"]["duration"]["value"], frames)
                    self.assertEqual(clip["source_range"]["duration"]["rate"], fps)
                    self.assertEqual(audio["children"][0]["OTIO_SCHEMA"], "Gap.1")
                    self.assertEqual(
                        audio["children"][0]["source_range"]["duration"]["value"],
                        frames,
                    )
                    self.assertNotIn("file://", reference["target_url"])
            repeated = json.loads((root / "still_30fps_repeat.otio").read_text("utf-8"))
            clips = repeated["tracks"]["children"][0]["children"]
            self.assertEqual(
                [c["source_range"]["duration"]["value"] for c in clips], [30, 60]
            )
            self.assertEqual(
                len({c["media_references"]["DEFAULT_MEDIA"]["target_url"] for c in clips}),
                1,
            )
            self.assertEqual(
                repeated["tracks"]["children"][1]["children"][0]["source_range"]
                ["duration"]["value"], 90,
            )
            self.assertEqual(image.read_bytes(), original)

    def test_wait_frame_rounding_half_up_exact_and_minimum_one(self):
        cases = (
            (24, Fraction(51, 50), 24),
            (30, Fraction(51, 50), 31),
            (60, Fraction(51, 50), 61),
            (24, Fraction(2), 48),
            (30, Fraction(2), 60),
            (60, Fraction(2), 120),
            (24, Fraction(1, 48), 1),  # exactly half of one frame
            (24, Fraction(3, 48), 2),  # 1.5 frames, round upward
            (24, Fraction(5, 48), 3),  # 2.5 frames, round upward
            (30, Fraction(1, 60), 1),
            (60, Fraction(3, 120), 2),
            (60, Fraction(1, 100000), 1),  # positive subframe wait
            (24, Fraction(1, 48) - Fraction(1, 10**12), 1),
            (24, Fraction(3, 48) - Fraction(1, 10**12), 1),
            (24, Fraction(3, 48) + Fraction(1, 10**12), 2),
        )
        for fps, seconds, expected in cases:
            with self.subTest(fps=fps, seconds=seconds):
                self.assertEqual(wait_frames(seconds, fps), expected)
        for seconds in (Fraction(0), Fraction(-1, 2), 0.5, "1.02", True):
            with self.subTest(seconds=seconds), self.assertRaises(ValueError):
                wait_frames(seconds, 30)
        for fps in (0, -24, 25, 29.97, True, "30"):
            with self.subTest(fps=fps), self.assertRaises(ValueError):
                wait_frames(Fraction(1), fps)

    def test_existing_user_image_stays_unchanged_and_no_output_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "日本語 e\u0301.png"
            create_synthetic_png(image)
            original = (image.read_bytes(), image.stat().st_mtime_ns)
            generate_probes(root / "output", image)
            self.assertEqual((image.read_bytes(), image.stat().st_mtime_ns), original)
            with self.assertRaises(FileExistsError):
                generate_probes(root / "output", image)
            self.assertEqual((image.read_bytes(), image.stat().st_mtime_ns), original)
            with self.assertRaises(FileExistsError):
                create_synthetic_png(image)

    def test_reject_opaque_invalid_paths_and_frame_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "alpha.png"
            create_synthetic_png(image)
            for fps, frames in ((25, (25,)), (30.0, (30,)),
                                (Fraction(30, 1), (30,)), (True, (30,)),
                                (30, ()), (30, (0,)),
                                (30, (True,)), (30, (-1,))):
                with self.subTest(fps=fps, frames=frames), self.assertRaises(ValueError):
                    build_still_timeline(image, fps, frames)
            opaque = root / "opaque.png"
            Image.new("RGBA", (4, 4), (12, 34, 56, 255)).save(opaque)
            with self.assertRaisesRegex(ValueError, "transparent"):
                build_still_timeline(opaque, 30, (30,))
            rgb = root / "rgb.png"
            Image.new("RGB", (4, 4), (12, 34, 56)).save(rgb)
            with self.assertRaisesRegex(ValueError, "RGBA"):
                build_still_timeline(rgb, 30, (30,))
            fake = root / "fake.png"
            fake.write_text("not a png")
            with self.assertRaises((ValueError, OSError)):
                build_still_timeline(fake, 30, (30,))
            with self.assertRaises(ValueError):
                build_still_timeline(root / "missing.png", 30, (30,))
            symlink = root / "link.png"
            try:
                symlink.symlink_to(image)
            except (OSError, NotImplementedError):
                pass
            else:
                with self.assertRaises(ValueError):
                    build_still_timeline(symlink, 30, (30,))


if __name__ == "__main__":
    unittest.main()
