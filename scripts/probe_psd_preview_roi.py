"""Read-only probe for changed-layer ROI PSD compositing (Issue #47).

This is a fidelity/performance experiment, not an enabled preview fast path.
Only a full-canvas RGBA byte-for-byte match can validate an individual sample.
"""

from __future__ import annotations

import argparse
from hashlib import sha256
from pathlib import Path
from time import perf_counter
import resource
import sys

from PIL import Image
from psd_tools import PSDImage

from tachie_motion.psd.raster import composite_rgba
from tachie_motion.psd.tree import walk_layers
from tachie_motion.psd.visibility import parse_index_path, resolve_layer


MAX_PROBE_PIXELS = 6_000_000


def clipped_bbox(
    bbox: tuple[int, int, int, int], width: int, height: int,
) -> tuple[int, int, int, int] | None:
    left, top, right, bottom = bbox
    region = (max(0, left), max(0, top), min(width, right), min(height, bottom))
    return region if region[0] < region[2] and region[1] < region[3] else None


def patch_matches_full(
    original: Image.Image, changed: Image.Image,
    region: Image.Image, box: tuple[int, int, int, int],
) -> tuple[bool, bool, bool]:
    """Check RGBA bytes, including transparent RGB and alpha, without tolerance."""
    if original.mode != "RGBA" or changed.mode != "RGBA" or region.mode != "RGBA":
        raise ValueError("Only RGBA images may be compared")
    if original.size != changed.size or region.size != (
        box[2] - box[0], box[3] - box[1],
    ):
        raise ValueError("ROI dimensions do not match the full canvas")
    crop_exact = region.tobytes() == changed.crop(box).tobytes()
    patched = original.copy()
    # No alpha blend: the ROI is already fully composited over transparency.
    patched.paste(region, box[:2])
    patch_exact = patched.tobytes() == changed.tobytes()
    changed_pixels = original.tobytes() != changed.tobytes()
    return crop_exact, patch_exact, changed_pixels


def render_region(psd: PSDImage, box: tuple[int, int, int, int]) -> Image.Image:
    """Use the same psd-tools settings as the full-canvas preview."""
    image = psd.composite(
        viewport=box, force=True, ignore_preview=True, alpha=0.0,
    )
    if image is None or image.size != (box[2] - box[0], box[3] - box[1]):
        raise RuntimeError("ROI compositor returned an invalid image")
    return image.convert("RGBA")


def digest(path: Path) -> str:
    value = sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def peak_rss_mib() -> float:
    units = 1024 * 1024 if sys.platform == "darwin" else 1024
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / units


def probe(psd: PSDImage, paths: list[str]) -> None:
    print(f"CANVAS={psd.width}x{psd.height}")
    print(f"LAYER_COUNT={len(list(walk_layers(psd)))}")
    start = perf_counter()
    original = composite_rgba(psd)
    print(f"BASE_FULL_S={perf_counter() - start:.3f}")
    for raw in paths:
        path = parse_index_path(raw)
        layer = resolve_layer(psd, path)
        old_visible = bool(layer.visible)
        bbox = tuple(layer.bbox)
        box = clipped_bbox(bbox, psd.width, psd.height)
        print(f"LAYER_PATH={raw}")
        print(f"LAYER_KIND={layer.kind}")
        print(f"ROI_BBOX={box}")
        if box is None:
            print("ROI_STATUS=SKIPPED_EMPTY_BBOX")
            continue
        print(f"ROI_CANVAS_RATIO={(box[2]-box[0])*(box[3]-box[1])/(psd.width*psd.height):.4f}")
        try:
            layer.visible = not old_visible
            start = perf_counter()
            full = composite_rgba(psd)
            full_seconds = perf_counter() - start
            start = perf_counter()
            part = render_region(psd, box)
            roi_seconds = perf_counter() - start
            crop_exact, patch_exact, changed_pixels = patch_matches_full(
                original, full, part, box,
            )
            print(f"TOGGLE_FULL_S={full_seconds:.3f}")
            print(f"TOGGLE_ROI_S={roi_seconds:.3f}")
            print(f"ROI_CROP_RGBA_EXACT={crop_exact}")
            print(f"ROI_PATCH_RGBA_EXACT={patch_exact}")
            print(f"IMAGE_CHANGED={changed_pixels}")
            # This is a necessary check for this single state, not a proof of
            # general correctness or a production optimization approval.
            print(f"ROI_CANDIDATE_VALID={crop_exact and patch_exact and changed_pixels}")
        finally:
            layer.visible = old_visible
        print(f"PEAK_RSS_MIB={peak_rss_mib():.1f}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("psd", type=Path, help="Existing local PSD; never modified")
    parser.add_argument(
        "--layer", action="append", dest="layers",
        help="0-based index path to toggle (e.g. 0 or 2/1); repeatable",
    )
    args = parser.parse_args()
    source = args.psd.expanduser().resolve(strict=True)
    if not source.is_file() or source.suffix.lower() != ".psd":
        parser.error("expected an existing .psd file")
    before_stat = source.stat()
    before_digest = digest(source)
    psd = PSDImage.open(source)
    if psd.width * psd.height > MAX_PROBE_PIXELS:
        parser.error("probe canvas limit exceeded (6 million pixels)")
    try:
        probe(psd, args.layers or ["0"])
    finally:
        after_stat = source.stat()
        unchanged = (before_stat.st_dev, before_stat.st_ino, before_stat.st_size,
                     before_stat.st_mtime_ns, before_stat.st_ctime_ns) == (
                     after_stat.st_dev, after_stat.st_ino, after_stat.st_size,
                     after_stat.st_mtime_ns, after_stat.st_ctime_ns)
        unchanged = unchanged and digest(source) == before_digest
        print("PSD_UNCHANGED_PASS" if unchanged else "PSD_CHANGED_FAIL")
    return 0 if unchanged else 1


if __name__ == "__main__":
    raise SystemExit(main())
