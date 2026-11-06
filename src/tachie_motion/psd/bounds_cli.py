"""Report a stable candidate crop for all possible PSD leaf visibility states."""

import argparse
import json
from pathlib import Path
import sys

from psd_tools import PSDImage

from tachie_motion.psd.bounds import compute_fixed_bounds, leaf_bboxes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report fixed crop bounds including currently hidden layers."
    )
    parser.add_argument("psd", type=Path, help="Original PSD")
    parser.add_argument(
        "--padding",
        type=int,
        default=16,
        help="Safety margin in pixels (default: 16; does not cover all effects)",
    )
    parser.add_argument("--json", action="store_true", help="Machine-readable report")
    args = parser.parse_args(argv)
    if not args.psd.is_file():
        parser.error("PSD file does not exist or is not a file")

    try:
        psd = PSDImage.open(args.psd)
        result = compute_fixed_bounds(
            leaf_bboxes(psd),
            canvas_width=psd.width,
            canvas_height=psd.height,
            padding=args.padding,
        )
    except (OSError, ValueError, TypeError, RuntimeError) as exc:
        print(f"PSD bounds failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    report = {
        "source_canvas": [result.canvas_width, result.canvas_height],
        "crop_box": list(result.box),
        "crop_size": [result.width, result.height],
        "crop_origin_in_psd": list(result.origin),
        "padding": result.padding,
        "leaf_layers_included": result.included_layers,
        "leaf_layers_excluded": result.excluded_layers,
    }
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"PSD canvas: {result.canvas_width} x {result.canvas_height}")
        print(
            f"Fixed crop: {result.width} x {result.height}"
            f" | box={result.box} | PSD origin={result.origin}"
        )
        print(
            f"Leaf layers: {result.included_layers} included,"
            f" {result.excluded_layers} empty/outside"
            f" | padding={result.padding}px"
        )
        print("Hidden layers included. Group bounds not used.")
        print(
            "Candidate only: layer effects, clipping/masks and future motion"
            " may require more margin; inspect rendered states before approval."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
