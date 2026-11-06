"""Conservative fixed PSD canvas bounds covering visible and hidden leaf layers.

This computes a candidate crop rectangle. Effects, masks and future movement
may extend beyond individual leaf bboxes, so the result needs visual validation.
"""

from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Protocol


Box = tuple[int, int, int, int]


class LayerLike(Protocol):
    @property
    def bbox(self) -> Box: ...
    def is_group(self) -> bool: ...
    def __iter__(self) -> Iterator["LayerLike"]: ...


@dataclass(frozen=True, slots=True)
class FixedBounds:
    left: int
    top: int
    right: int
    bottom: int
    canvas_width: int
    canvas_height: int
    padding: int
    included_layers: int
    excluded_layers: int

    @property
    def box(self) -> Box:
        return self.left, self.top, self.right, self.bottom

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top

    @property
    def origin(self) -> tuple[int, int]:
        """Crop's upper-left corner in original PSD coordinates."""
        return self.left, self.top


def leaf_bboxes(layers: Iterable[LayerLike]) -> Iterator[Box]:
    """Include hidden alternatives, but never use a group's derived bbox."""
    for layer in layers:
        if layer.is_group():
            yield from leaf_bboxes(layer)
        else:
            yield tuple(layer.bbox)


def compute_fixed_bounds(
    boxes: Iterable[Box],
    *,
    canvas_width: int,
    canvas_height: int,
    padding: int = 16,
) -> FixedBounds:
    """Union leaf bboxes, clamp to PSD canvas, and apply symmetric padding.

    Does not depend on visibility, chosen mouth or pose. Output coordinates
    remain stable across every state of an unchanged PSD with the same options.
    Right/bottom even-dimension padding may extend 1px beyond the PSD\n    canvas. The top-left origin stays fixed. This is a conservative candidate,\n    not a guarantee for all layer effects.
    """
    if canvas_width <= 0 or canvas_height <= 0:
        raise ValueError("PSD canvas must have positive dimensions")
    if padding < 0:
        raise ValueError("Padding must not be negative")

    left, top = canvas_width, canvas_height
    right, bottom = 0, 0
    included = excluded = 0

    for x0, y0, x1, y1 in boxes:
        # Empty, inverted or entirely off-canvas elements cannot add pixels
        # inside the PSD's own visible canvas.
        x0 = max(0, min(canvas_width, x0))
        y0 = max(0, min(canvas_height, y0))
        x1 = max(0, min(canvas_width, x1))
        y1 = max(0, min(canvas_height, y1))
        if x1 <= x0 or y1 <= y0:
            excluded += 1
            continue

        included += 1
        left = min(left, x0)
        top = min(top, y0)
        right = max(right, x1)
        bottom = max(bottom, y1)

    if included == 0:
        raise ValueError("No nonempty leaf layers within the PSD canvas")

    crop_left = max(0, left - padding)
    crop_top = max(0, top - padding)
    crop_right = min(canvas_width, right + padding)
    crop_bottom = min(canvas_height, bottom + padding)
    # Keep the PSD-coordinate origin fixed. PIL pads any pixels outside the
    # source canvas with transparent black (including an odd-height bottom).
    if (crop_right - crop_left) % 2:
        crop_right += 1
    if (crop_bottom - crop_top) % 2:
        crop_bottom += 1

    return FixedBounds(
        left=crop_left,
        top=crop_top,
        right=crop_right,
        bottom=crop_bottom,
        canvas_width=canvas_width,
        canvas_height=canvas_height,
        padding=padding,
        included_layers=included,
        excluded_layers=excluded,
    )
