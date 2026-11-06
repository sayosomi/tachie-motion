"""F-05 regressions: localized changes hidden by whole-image mean error."""

from pathlib import Path
import shutil
import tempfile
import unittest

from PIL import Image, ImageChops, ImageDraw, ImageStat

from tachie_motion.render.change_regions import build_change_tiles, check_changed_tiles
from tachie_motion.render.probe import inspect_prores
from tachie_motion.render.prores import encode_prores, read_rgba_states


def make_character(path: Path, *, mouth: str) -> None:
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    brush = ImageDraw.Draw(image)
    brush.rectangle((30, 30, 480, 480), fill=(120, 150, 170, 255))
    if mouth == "red":
        brush.rectangle((240, 300, 259, 319), fill=(255, 0, 0, 255))
    elif mouth == "blue":
        brush.rectangle((240, 300, 259, 319), fill=(0, 0, 255, 255))
    elif mouth == "missing":
        # Mouth deletion is visibly different from the normal body.
        brush.rectangle((240, 300, 259, 319), fill=(0, 0, 0, 0))
    else:
        raise ValueError(mouth)
    image.save(path)


class ChangedRegionTests(unittest.TestCase):
    def test_small_mouth_difference_is_localized_below_whole_frame_threshold(self):
        with tempfile.TemporaryDirectory() as temp:
            a, b = Path(temp) / "a.png", Path(temp) / "b.png"
            make_character(a, mouth="red")
            make_character(b, mouth="blue")
            dims, states = read_rgba_states([a, b])
            expected_a = Image.frombytes("RGBA", dims, states[0])
            expected_b = Image.frombytes("RGBA", dims, states[1])
            diff = ImageChops.difference(
                expected_a.convert("RGB"), expected_b.convert("RGB")
            )
            visible = expected_b.getchannel("A").point(
                lambda value: 255 if value >= 128 else 0
            )
            self.assertLess(max(ImageStat.Stat(diff, mask=visible).mean), 1.0)
            tiles = build_change_tiles(states, dims)
            self.assertGreater(len(tiles), 0)
            self.assertLessEqual(len(tiles), 4)
            # The correct switch passes; an unchanged mouth on frame B fails
            # despite tiny whole-frame mean error.
            check_changed_tiles(expected_b, expected_b, tiles, frame_index=1)
            with self.assertRaisesRegex(RuntimeError, "(?:localized|global block) RGB"):
                check_changed_tiles(
                    expected_a, expected_b, tiles, frame_index=1
                )

    def test_small_alpha_deletion_is_not_diluted(self):
        with tempfile.TemporaryDirectory() as temp:
            a, b = Path(temp) / "a.png", Path(temp) / "b.png"
            make_character(a, mouth="red")
            make_character(b, mouth="missing")
            dims, states = read_rgba_states([a, b])
            expected_a = Image.frombytes("RGBA", dims, states[0])
            expected_b = Image.frombytes("RGBA", dims, states[1])
            whole_alpha_error = ImageStat.Stat(
                ImageChops.difference(
                    expected_a.getchannel("A"), expected_b.getchannel("A")
                )
            ).mean[0]
            self.assertLess(whole_alpha_error, 3.0)
            tiles = build_change_tiles(states, dims)
            self.assertGreater(len(tiles), 0)
            with self.assertRaisesRegex(RuntimeError, "(?:localized|global block) alpha"):
                check_changed_tiles(
                    expected_a, expected_b, tiles, frame_index=1
                )


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "FFmpeg and ffprobe required for ProRes localized integration",
)
class ChangedRegionProresIntegration(unittest.TestCase):
    def test_reencoded_video_with_missing_mouth_switch_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            first, second = folder / "red.png", folder / "blue.png"
            make_character(first, mouth="red")
            make_character(second, mouth="blue")
            video = folder / "wrong-switch.mov"
            # Deliberately encode an unchanged mouth in both states.
            # It passes ordinary MOV decode/profile/alpha checks.
            encode_prores(
                [first, first], video, fps=30, frames_per_state=2
            )
            dimensions, expected = read_rgba_states([first, second])
            with self.assertRaisesRegex(RuntimeError, "(?:localized|global block) RGB"):
                inspect_prores(
                    video,
                    expected_size=dimensions,
                    expected_frames=4,
                    expected_fps=30,
                    source_states=expected,
                    frames_per_state=2,
                )


if __name__ == "__main__":
    unittest.main()
