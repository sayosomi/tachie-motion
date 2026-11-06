"""Manually bound two-state mouth PNGs from an immutable PSD source.

Each state begins with the original PSD visibility; only the two explicitly
bound mouth layers change. Both share one fixed original-coordinate crop.
"""

from pathlib import Path

from psd_tools import PSDImage

from tachie_motion.psd.crop import write_fixed_crop_png
from tachie_motion.psd.visibility import (
    apply_visibility, parse_index_path, resolve_layer,
)


def render_mouth_variants(
    source: Path, *, closed_path: str, open_path: str,
    directory: Path, padding: int = 16,
) -> tuple[Path, Path]:
    """Render closed and open mouth; reject ambiguous or hidden bindings."""
    if not source.is_file() or source.suffix.lower() != ".psd":
        raise ValueError("Expected an existing PSD source")
    closed = parse_index_path(closed_path)
    opened = parse_index_path(open_path)
    if (
        closed == opened
        or closed[:len(opened)] == opened
        or opened[:len(closed)] == closed
    ):
        raise ValueError("Mouth bindings must be distinct, non-overlapping layers")
    psd = PSDImage.open(source)
    a, b = resolve_layer(psd, closed), resolve_layer(psd, opened)
    if a.is_group() or b.is_group():
        raise ValueError("Mouth bindings must identify leaf layers, not groups")

    directory.mkdir(parents=True, exist_ok=True)
    closed_png = directory / "mouth-closed.png"
    open_png = directory / "mouth-open.png"
    apply_visibility(psd, show=[closed_path], hide=[open_path])
    first = write_fixed_crop_png(psd, closed_png, padding=padding)
    apply_visibility(psd, show=[open_path], hide=[closed_path])
    second = write_fixed_crop_png(psd, open_png, padding=padding)
    if first.bounds.box != second.bounds.box:
        raise RuntimeError("Mouth states have inconsistent fixed crop bounds")
    return closed_png, open_png
