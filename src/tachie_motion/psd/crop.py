"""Render on the original PSD canvas, then crop using fixed all-layer bounds.

The source PSD stays untouched on disk. Every render from one unchanged PSD
uses the same origin and dimensions, regardless of active visibility.
"""

from dataclasses import dataclass
from pathlib import Path

from psd_tools import PSDImage

from tachie_motion.psd.bounds import Box, FixedBounds, compute_fixed_bounds, leaf_bboxes
from tachie_motion.psd.raster import composite_rgba


@dataclass(frozen=True, slots=True)
class CropReport:
    bounds: FixedBounds
    alpha_box: Box | None


def write_fixed_crop_png(
    psd: PSDImage,
    output: Path,
    *,
    padding: int = 16,
) -> CropReport:
    """Write a fixed-size PNG; reject crops that discard nontransparent pixels.

    Layer bbox unions are a candidate crop. Effects and masks can extend past
    the union, so verify the alpha extent in the freshly rendered full canvas.
    This only checks the current visible state; other states must be sampled.
    """
    bounds = compute_fixed_bounds(
        leaf_bboxes(psd),
        canvas_width=psd.width,
        canvas_height=psd.height,
        padding=padding,
    )
    full = composite_rgba(psd)
    alpha_box = full.getchannel("A").getbbox()

    if alpha_box is not None:
        x0, y0, x1, y1 = alpha_box
        if (
            x0 < bounds.left
            or y0 < bounds.top
            or x1 > bounds.right
            or y1 > bounds.bottom
        ):
            raise RuntimeError(
                "Rendered pixels extend beyond fixed crop: "
                f"alpha_bbox={alpha_box}, crop_box={bounds.box}. "
                "Increase --padding or revise the crop calculation."
            )

    output.parent.mkdir(parents=True, exist_ok=True)
    full.crop(bounds.box).save(output)
    return CropReport(bounds=bounds, alpha_box=alpha_box)
