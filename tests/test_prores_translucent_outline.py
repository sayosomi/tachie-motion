"""F-06 / F-07: broken translucent mouths and unchanged black outlines."""

from pathlib import Path
import shutil
import tempfile
import unittest

from PIL import Image, ImageChops, ImageDraw, ImageStat

from tachie_motion.render.change_regions import (
    build_change_tiles, check_changed_tiles,
)
from tachie_motion.render.probe import inspect_prores
from tachie_motion.render.prores import encode_prores, read_rgba_states

MOUTH = (240, 300, 259, 319)
INSIDE = (242, 302, 257, 317)


def make_mouth(path: Path, *, color: str, translucent: bool = False,
               erase_outline: bool = False) -> None:
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((30, 30, 480, 480), fill=(120, 150, 170, 255))
    if translucent:
        draw.rectangle(
            MOUTH,
            fill=(255, 0, 0, 120) if color == "red" else (0, 0, 255, 120),
        )
    else:
        draw.rectangle(MOUTH, fill=(0, 0, 0, 255))
        draw.rectangle(
            INSIDE,
            fill=(255, 0, 0, 255) if color == "red" else (0, 0, 255, 255),
        )
        if erase_outline:
            # The unchanged 2px black contour is deleted; only the colored
            # interior differs between the valid source states.
            for y in range(MOUTH[1], MOUTH[3] + 1):
                for x in range(MOUTH[0], MOUTH[2] + 1):
                    if not (INSIDE[0] <= x <= INSIDE[2]
                            and INSIDE[1] <= y <= INSIDE[3]):
                        image.putpixel((x, y), (0, 0, 0, 0))
    image.save(path)


class TranslucentAndOutlineTests(unittest.TestCase):
    def test_f06_translucent_alpha120_mouth_color_corruption_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a, b = root / "red.png", root / "blue.png"
            make_mouth(a, color="red", translucent=True)
            make_mouth(b, color="blue", translucent=True)
            dims, states = read_rgba_states([a, b])
            before, expected = (
                Image.frombytes("RGBA", dims, state) for state in states
            )
            self.assertEqual(expected.getpixel((245, 305))[3], 120)
            # The old >=128 RGB mask excludes the entire corrupted feature.
            visible = expected.getchannel("A").point(
                lambda v: 255 if v >= 128 else 0
            )
            self.assertEqual(
                max(ImageStat.Stat(
                    ImageChops.difference(
                        before.convert("RGB"), expected.convert("RGB")
                    ), mask=visible
                ).mean), 0.0
            )
            self.assertEqual(
                ImageChops.difference(
                    before.getchannel("A"), expected.getchannel("A")
                ).getbbox(), None
            )
            tiles = build_change_tiles(states, dims)
            self.assertGreater(len(tiles), 0)
            check_changed_tiles(expected, expected, tiles, frame_index=1)
            with self.assertRaisesRegex(RuntimeError, "(?:localized|global block) RGB"):
                check_changed_tiles(before, expected, tiles, frame_index=1)

    def test_f07_unchanged_black_outline_alpha_loss_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a, b, broken = (
                root / "red.png", root / "blue.png", root / "broken.png"
            )
            make_mouth(a, color="red")
            make_mouth(b, color="blue")
            make_mouth(broken, color="blue", erase_outline=True)
            dims, states = read_rgba_states([a, b])
            expected = Image.frombytes("RGBA", dims, states[1])
            with Image.open(broken) as corrupt:
                actual = corrupt.convert("RGBA")
            # 20x20 mouth, 16x16 interior => exactly 144 invariant
            # border pixels deleted; full-frame alpha MAE still <3.
            alpha_diff = ImageChops.difference(
                actual.getchannel("A"), expected.getchannel("A")
            )
            self.assertEqual(alpha_diff.histogram()[255], 144)
            self.assertLess(ImageStat.Stat(alpha_diff).mean[0], 3.0)
            tiles = build_change_tiles(states, dims)
            self.assertGreater(len(tiles), 0)
            # The changed mask specifically excludes the invariant contour.
            contour_tiles = [
                tile for tile in tiles
                if tile.box[0] <= 240 < tile.box[2]
                and tile.box[1] <= 300 < tile.box[3]
            ]
            self.assertTrue(contour_tiles)
            for tile in contour_tiles:
                self.assertEqual(
                    tile.mask.getpixel((240 - tile.box[0], 300 - tile.box[1])),
                    0,
                )
            check_changed_tiles(expected, expected, tiles, frame_index=1)
            with self.assertRaisesRegex(RuntimeError, "(?:localized|global block) alpha"):
                check_changed_tiles(actual, expected, tiles, frame_index=1)


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "FFmpeg and ffprobe required for ProRes F-06/07 integration",
)
class TranslucentAndOutlineMovTests(unittest.TestCase):
    def test_f06_real_mov_missing_translucent_mouth_switch_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a, b = root / "red.png", root / "blue.png"
            make_mouth(a, color="red", translucent=True)
            make_mouth(b, color="blue", translucent=True)
            mov = root / "wrong-translucent.mov"
            encode_prores([a, a], mov, fps=30, frames_per_state=2)
            dims, states = read_rgba_states([a, b])
            with self.assertRaisesRegex(RuntimeError, "(?:localized|global block) RGB"):
                inspect_prores(
                    mov, expected_size=dims, expected_frames=4,
                    expected_fps=30, source_states=states, frames_per_state=2,
                )

    def test_f07_real_mov_missing_invariant_outline_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first, second, damaged = (
                root / "red.png", root / "blue.png", root / "damaged.png"
            )
            make_mouth(first, color="red")
            make_mouth(second, color="blue")
            make_mouth(damaged, color="blue", erase_outline=True)
            mov = root / "wrong-outline.mov"
            encode_prores([first, damaged], mov, fps=30, frames_per_state=2)
            dims, states = read_rgba_states([first, second])
            with self.assertRaisesRegex(RuntimeError, "(?:localized|global block) alpha"):
                inspect_prores(
                    mov, expected_size=dims, expected_frames=4,
                    expected_fps=30, source_states=states, frames_per_state=2,
                )


if __name__ == "__main__":
    unittest.main()
