"""Validate small animated features, including translucent pixels and outlines.

Adjacent source states identify candidate 32px tiles. Each candidate covers
the source-change pixels AND their unchanged surroundings, with a short halo
across grid boundaries. A premultiplied-RGB comparison includes translucent
pixels while avoiding false positives from invisible RGB under alpha=0.
"""

from collections.abc import Sequence
from dataclasses import dataclass

from PIL import Image, ImageChops, ImageStat


@dataclass(frozen=True)
class ChangeTile:
    box: tuple[int, int, int, int]
    mask: Image.Image  # Source-state changes; does not limit coverage.
    pixels: int


def _premultiplied_channel(rgb: Image.Image, alpha: Image.Image) -> Image.Image:
    return ImageChops.multiply(rgb, alpha)


def _visible_change_mask(before: Image.Image, after: Image.Image) -> Image.Image:
    a_before = before.getchannel("A")
    a_after = after.getchannel("A")
    delta = ImageChops.difference(a_before, a_after)
    for name in ("R", "G", "B"):
        before_visible = _premultiplied_channel(before.getchannel(name), a_before)
        after_visible = _premultiplied_channel(after.getchannel(name), a_after)
        delta = ImageChops.lighter(
            delta, ImageChops.difference(before_visible, after_visible)
        )
    return delta.point(lambda value: 255 if value >= 8 else 0)


def build_change_tiles(
    source_states: Sequence[bytes],
    dimensions: tuple[int, int],
    *,
    tile_size: int = 32,
    halo: int = 4,
) -> list[ChangeTile]:
    """Find transition tiles, including neighboring invariant edges.

    The change threshold selects candidate *tiles* only. Verification covers
    the whole selected tile, not just the changed mask.
    """
    if tile_size < 1 or halo < 0:
        raise ValueError("tile_size must be positive and halo nonnegative")
    if len(source_states) < 2:
        return []
    states = [
        Image.frombytes("RGBA", dimensions, frame) for frame in source_states
    ]
    width, height = dimensions
    tiles: list[ChangeTile] = []
    for before, after in zip(states, states[1:]):
        change = _visible_change_mask(before, after)
        bounds = change.getbbox()
        if bounds is None:
            continue
        x0, y0, x1, y1 = bounds
        for top in range((y0 // tile_size) * tile_size, y1, tile_size):
            for left in range((x0 // tile_size) * tile_size, x1, tile_size):
                core = (
                    left, top,
                    min(left + tile_size, width),
                    min(top + tile_size, height),
                )
                if change.crop(core).getbbox() is None:
                    continue
                box = (
                    max(0, left - halo),
                    max(0, top - halo),
                    min(width, core[2] + halo),
                    min(height, core[3] + halo),
                )
                mask = change.crop(box)
                tiles.append(ChangeTile(box, mask, mask.histogram()[255]))
    return tiles


def _premultiplied_difference(
    actual: Image.Image, expected: Image.Image
) -> tuple[Image.Image, Image.Image]:
    actual_alpha = actual.getchannel("A")
    expected_alpha = expected.getchannel("A")
    alpha_diff = ImageChops.difference(actual_alpha, expected_alpha)
    rgb_diffs = [
        ImageChops.difference(
            _premultiplied_channel(actual.getchannel(name), actual_alpha),
            _premultiplied_channel(expected.getchannel(name), expected_alpha),
        )
        for name in ("R", "G", "B")
    ]
    return alpha_diff, Image.merge("RGB", rgb_diffs)


def _bad_fraction(
    diff: Image.Image, limit: int, count: int, mask: Image.Image | None
) -> float:
    bad = diff.point(lambda value: 255 if value > limit else 0)
    if mask is not None:
        bad = ImageChops.multiply(bad, mask)
    return bad.histogram()[255] / count


def check_changed_tiles(
    actual: Image.Image,
    expected: Image.Image,
    tiles: Sequence[ChangeTile],
    *,
    frame_index: int,
    max_alpha_mae: float = 10.0,
    max_rgb_mae: float = 20.0,
    max_bad_fraction: float = 0.10,
) -> tuple[float, float]:
    """Check source-changing pixels AND unchanged neighboring outlines.

    F-06: use premultiplied color differences for all alpha levels, including
    1..127, rather than discarding semi-transparent RGB.
    F-07: check the entire selected tile (plus halo) so unchanged outlines
    corrupted in the MOV are not excluded by the source-change mask.

    Both region-wide and source-change-only checks are required. The latter
    remains sensitive when only a few pixels vary inside a larger tile.
    """
    max_seen_alpha = max_seen_rgb = 0.0
    for tile in tiles:
        source = expected.crop(tile.box)
        result = actual.crop(tile.box)
        alpha_diff, rgb_diff = _premultiplied_difference(result, source)
        worst_rgb = ImageChops.lighter(
            ImageChops.lighter(
                rgb_diff.getchannel("R"), rgb_diff.getchannel("G")
            ),
            rgb_diff.getchannel("B"),
        )
        box_area = (tile.box[2] - tile.box[0]) * (tile.box[3] - tile.box[1])
        for scope, mask, count in (
            ("change", tile.mask, tile.pixels),
            ("whole tile", None, box_area),
        ):
            if count == 0:
                continue
            alpha_mae = ImageStat.Stat(alpha_diff, mask=mask).mean[0]
            rgb_mae = max(ImageStat.Stat(rgb_diff, mask=mask).mean)
            max_seen_alpha = max(max_seen_alpha, alpha_mae)
            max_seen_rgb = max(max_seen_rgb, rgb_mae)
            alpha_bad = _bad_fraction(alpha_diff, 64, count, mask)
            rgb_bad = _bad_fraction(worst_rgb, 96, count, mask)
            if alpha_mae > max_alpha_mae or alpha_bad > max_bad_fraction:
                raise RuntimeError(
                    f"Decoded frame {frame_index}: localized alpha fidelity mismatch"
                    f" ({scope} {tile.box}; MAE={alpha_mae:.3f},"
                    f" bad={alpha_bad:.3%})"
                )
            if rgb_mae > max_rgb_mae or rgb_bad > max_bad_fraction:
                raise RuntimeError(
                    f"Decoded frame {frame_index}: localized RGB content mismatch"
                    f" ({scope} {tile.box}; premultiplied MAE={rgb_mae:.3f},"
                    f" bad={rgb_bad:.3%})"
                )
    return max_seen_alpha, max_seen_rgb
