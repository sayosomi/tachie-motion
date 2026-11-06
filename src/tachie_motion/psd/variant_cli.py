"""Export PNGs with explicit PSD visibility overrides and optional fixed crop."""

import argparse
from pathlib import Path
import sys

from psd_tools import PSDImage

from tachie_motion.psd.crop import write_fixed_crop_png
from tachie_motion.psd.raster import write_layer_png
from tachie_motion.psd.visibility import apply_visibility


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Render manual PSD visibility changes without saving the PSD."
    )
    parser.add_argument("psd", type=Path, help="Source PSD file")
    parser.add_argument(
        "--show",
        action="append",
        default=[],
        metavar="PATH",
        help="Show layer at index path, e.g. 4/0 (repeatable)",
    )
    parser.add_argument(
        "--hide",
        action="append",
        default=[],
        metavar="PATH",
        help="Hide layer at index path, e.g. 4/2 (repeatable)",
    )
    parser.add_argument(
        "--fixed-crop",
        action="store_true",
        help="Crop to the same all-layer bounds for every visibility state",
    )
    parser.add_argument(
        "--padding",
        type=int,
        default=16,
        help="Crop padding in pixels (with --fixed-crop, default: 16)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Destination PNG (e.g. output/psd-preview/fixed-mouth.png)",
    )
    args = parser.parse_args(argv)

    if not args.psd.is_file():
        parser.error("Source PSD does not exist or is not a file")
    if args.output.suffix.lower() != ".png":
        parser.error("--output must have a .png extension")
    if not args.fixed_crop and not (args.show or args.hide):
        parser.error("At least one --show/--hide or --fixed-crop is required")
    if not args.fixed_crop and args.padding != 16:
        parser.error("--padding applies only when --fixed-crop is set")

    try:
        psd = PSDImage.open(args.psd)
        changes = (
            apply_visibility(psd, show=args.show, hide=args.hide)
            if args.show or args.hide
            else []
        )
        if args.fixed_crop:
            report = write_fixed_crop_png(psd, args.output, padding=args.padding)
        else:
            write_layer_png(psd, args.output)
    except (OSError, ValueError, TypeError, RuntimeError, ImportError) as exc:
        print(
            f"Layer variant rendering failed: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 2

    for change in changes:
        path = "/".join(map(str, change.path))
        print(f"[{path}] {change.name!r}: {change.before} -> {change.after}")
    if args.fixed_crop:
        print(
            f"Fixed crop: {report.bounds.width} x {report.bounds.height}"
            f" | box={report.bounds.box}"
            f" | PSD origin={report.bounds.origin}"
        )
        print(f"Actual nontransparent pixels (PSD coords): {report.alpha_box}")
        print("Alpha containment check: PASS (current visible state)")
    print(f"PNG: {args.output}")
    print("Source PSD was not saved or modified on disk.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
