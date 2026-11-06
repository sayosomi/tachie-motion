"""Read-only PSD rendering comparison for Issue #1."""

import argparse
from pathlib import Path
import sys

from psd_tools import PSDImage

from tachie_motion.psd.raster import write_comparison_images


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compare embedded PSD preview with freshly composited layers."
    )
    parser.add_argument("psd", type=Path, help="Path to PSD file")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("output/psd-preview"),
        help="Destination for PNG previews (default: output/psd-preview)",
    )
    args = parser.parse_args(argv)
    if not args.psd.is_file():
        print("PSD file does not exist or is not a regular file.", file=sys.stderr)
        return 2

    try:
        psd = PSDImage.open(args.psd)
        results = write_comparison_images(psd, args.output_dir)
    except (OSError, ValueError, TypeError, RuntimeError, ImportError) as exc:
        print(f"PSD render failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    for kind, path in results.items():
        print(f"{kind}: {path}")
    print("Source PSD was not changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
