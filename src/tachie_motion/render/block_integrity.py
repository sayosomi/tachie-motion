"""Frame-wide ProRes fidelity gates, independent of state-transition masks.

1. Exact sliding 8x8 windows find clustered *severe* RGB/alpha defects at
   arbitrary pixel offsets, including grid boundaries.
2. Sliding 32x32 area-mean tests detect *moderate but sustained* errors,
   including unchanged semitransparent panels, without requiring a single
   pixel to exceed the severe-error threshold.

Thresholds are lossy-codec tolerances, not pixel-perfect reproduction.
Invisible straight RGB is ignored, but premultiplied RGB is compared across
all alpha levels for the area-mean gate.
"""

import numpy as np
from PIL import Image, ImageChops, ImageFilter


def _max_bad_pixels_per_block(bad_mask: Image.Image, block_size: int) -> int:
    """Exact highest occupancy of ANY sliding block_size-square window.

    Keep only nonzero bounds to avoid scanning the full 4K frame when clean.
    Native Pillow 8-bit image additions accumulate 1 per flagged pixel; their
    sum stays <=64 for the supported 8px window. Seven horizontal and seven
    vertical offsets give the sliding sum at every possible pixel origin.
    The right/bottom padding prevents ImageChops.offset wraparound artifacts.
    """
    bounds = bad_mask.getbbox()
    if bounds is None:
        return 0
    cropped = bad_mask.crop(bounds)
    # Even two distant defects need an exact reported maximum; a previous
    # shortcut returned the total count and overstated low occupancies.
    width, height = cropped.size
    expanded = Image.new(
        "L", (width + block_size - 1, height + block_size - 1)
    )
    expanded.paste(cropped.point(lambda value: 1 if value else 0), (0, 0))
    horizontal = expanded.copy()
    for dx in range(1, block_size):
        horizontal = ImageChops.add(
            horizontal, ImageChops.offset(expanded, -dx, 0)
        )
    summed = horizontal.copy()
    for dy in range(1, block_size):
        summed = ImageChops.add(
            summed, ImageChops.offset(horizontal, 0, -dy)
        )
    return summed.crop((0, 0, width, height)).getextrema()[1]


def _max_area_mean(
    error: Image.Image,
    tile_size: int = 32,
    *,
    threshold: int = 18,
) -> float:
    """Return a mean > threshold if *any* sliding 32x32 window exceeds it.

    An optimized native-code BoxBlur(16) is a conservative *screen* only:
    any 32x32 sum > threshold*1024 must also exceed that sum in some
    containing 33x33 neighborhood. An intentionally lowered blur cutoff
    accommodates 8-bit rounding. A possible hit is then checked by an
    exact integer-vectorized rolling sum over an expanded candidate ROI.

    Thus neither the rejection nor the acceptance depends on the original
    32px grid alignment. Ordinary clean/lossy frames avoid Python-level
    full-frame loops. Results <= threshold are intentionally returned as
    0: callers use this as a threshold-exceedance detector, not as a
    general-purpose peak-MAE reporting function.
    """
    if tile_size != 32:
        raise ValueError("Area window size must be 32")
    if threshold < 0:
        raise ValueError("Area mean threshold must be nonnegative")
    if error.mode != "L":
        raise ValueError("Expected an 8-bit grayscale difference image")
    # Mathematical fast path: every 32x32 mean is bounded above by
    # the maximum individual error. Exact even with scattered differences.
    # Especially important for codec-wide subthreshold noise.
    if error.getextrema()[1] <= threshold:
        return 0.0

    width, height = error.size
    # A positive 32x32 window is contained in a 33x33 BoxBlur footprint
    # centered one pixel inside that window. Pillow rounds blur output to
    # 8-bit; subtract an additional two levels for conservative screening.
    # Threshold=18 -> screen >=14, safely below 18*1024/1089 ~=16.93.
    cutoff = max(1, int(threshold * 1024 / 1089) - 2)
    coarse = error.filter(ImageFilter.BoxBlur(16))
    if coarse.getextrema()[1] < cutoff:
        return 0.0
    candidates = coarse.point(
        lambda value: 255 if value >= cutoff else 0
    )
    bounds = candidates.getbbox()
    if bounds is None:
        return 0.0
    # Expand well beyond the containing blur kernel so candidate windows
    # at the image's edges and across prior tile seams are evaluated whole.
    x0 = max(0, bounds[0] - tile_size)
    y0 = max(0, bounds[1] - tile_size)
    x1 = min(width, bounds[2] + tile_size)
    y1 = min(height, bounds[3] + tile_size)
    roi = error.crop((x0, y0, x1, y1))
    w, h = roi.size
    if w < tile_size or h < tile_size:
        expanded = Image.new("L", (max(w, tile_size), max(h, tile_size)))
        expanded.paste(roi, (0, 0))
        roi = expanded
        w, h = roi.size

    # Integer-vectorized rolling 32x32 sum; max is at most 255*1024,
    # safely within signed int32. No Python per-pixel loops on large ROIs.
    # A 1D cumulative sum is applied to each axis, then window endpoints
    # are subtracted, so every offset is tested exactly (F-10).
    values = np.asarray(roi, dtype=np.int32)
    width_sum = np.cumsum(values, axis=1, dtype=np.int32)
    horizontal = width_sum[:, tile_size - 1:].copy()
    if width_sum.shape[1] > tile_size:
        horizontal[:, 1:] -= width_sum[:, :-tile_size]
    height_sum = np.cumsum(horizontal, axis=0, dtype=np.int32)
    windows = height_sum[tile_size - 1:].copy()
    if height_sum.shape[0] > tile_size:
        windows[1:] -= height_sum[:-tile_size]
    peak = int(windows.max())
    limit = threshold * tile_size * tile_size
    return peak / (tile_size * tile_size) if peak > limit else 0.0


def _premul(image: Image.Image, channel: str) -> Image.Image:
    return ImageChops.multiply(image.getchannel(channel), image.getchannel("A"))


def check_frame_blocks(
    actual: Image.Image,
    expected: Image.Image,
    *,
    frame_index: int,
    block_size: int = 8,
    min_bad_pixels: int = 8,
    alpha_pixel_limit: int = 48,
    rgb_pixel_limit: int = 96,
    min_color_alpha: int = 4,
    max_area_alpha_mae: int = 18,
    max_area_rgb_mae: int = 18,
) -> tuple[int, int]:
    """Reject local severe damage and sustained moderate damage anywhere.

    The area gate compares alpha and premultiplied RGB across the *whole*
    image (including invariant alpha=120 layers). A small sparse set of
    ProRes quantization artifacts is tolerated by both spatial criteria.
    """
    if actual.size != expected.size:
        raise ValueError("Comparison image dimensions differ")
    if block_size != 8 or not 1 <= min_bad_pixels <= 64:
        raise ValueError("Supported block_size is 8 and bad-pixel count 1..64")
    if not 1 <= min_color_alpha <= 255:
        raise ValueError("Invalid minimum alpha")
    if min(max_area_alpha_mae, max_area_rgb_mae) < 0:
        raise ValueError("Area-error tolerances must not be negative")

    a = actual.convert("RGBA")
    b = expected.convert("RGBA")
    aa, ea = a.getchannel("A"), b.getchannel("A")
    alpha_diff = ImageChops.difference(aa, ea)
    bad_alpha = alpha_diff.point(
        lambda v: 255 if v > alpha_pixel_limit else 0
    )
    peak_alpha = _max_bad_pixels_per_block(bad_alpha, block_size)
    if peak_alpha >= min_bad_pixels:
        raise RuntimeError(
            f"Decoded frame {frame_index}: global block alpha fidelity mismatch"
            f" ({peak_alpha} bad pixels in sliding {block_size}x{block_size} window)"
        )

    visible_in_both = ImageChops.multiply(
        ea.point(lambda v: 255 if v >= min_color_alpha else 0),
        aa.point(lambda v: 255 if v >= min_color_alpha else 0),
    )
    rgb_difference = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    max_color = ImageChops.lighter(
        ImageChops.lighter(
            rgb_difference.getchannel("R"), rgb_difference.getchannel("G")
        ),
        rgb_difference.getchannel("B"),
    )
    bad_rgb = ImageChops.multiply(
        max_color.point(lambda v: 255 if v > rgb_pixel_limit else 0),
        visible_in_both,
    )
    peak_rgb = _max_bad_pixels_per_block(bad_rgb, block_size)
    if peak_rgb >= min_bad_pixels:
        raise RuntimeError(
            f"Decoded frame {frame_index}: global block RGB content mismatch"
            f" ({peak_rgb} bad pixels in sliding {block_size}x{block_size} window)"
        )

    # Moderate changes can be visually important on large translucent
    # features even if *no individual pixel* exceeds the severe threshold.
    area_alpha = _max_area_mean(alpha_diff, threshold=max_area_alpha_mae)
    if area_alpha > max_area_alpha_mae:
        raise RuntimeError(
            f"Decoded frame {frame_index}: global area alpha fidelity mismatch"
            f" (32x32 mean error {area_alpha} > {max_area_alpha_mae})"
        )

    area_rgb = max(
        _max_area_mean(
            ImageChops.difference(_premul(a, channel), _premul(b, channel)),
            threshold=max_area_rgb_mae,
        )
        for channel in ("R", "G", "B")
    )
    if area_rgb > max_area_rgb_mae:
        raise RuntimeError(
            f"Decoded frame {frame_index}: global area RGB content mismatch"
            f" (32x32 premultiplied mean error {area_rgb}"
            f" > {max_area_rgb_mae})"
        )
    return peak_alpha, peak_rgb
