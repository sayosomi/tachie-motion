"""Small read-only PSD layer inspection command for Issue #1."""

import argparse
from dataclasses import asdict
import json
from pathlib import Path
import sys

from psd_tools import PSDImage

from tachie_motion.psd.tree import walk_layers


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Display the original PSD layer tree (no auto classification)."
    )
    parser.add_argument("psd", type=Path, help="Path to a local PSD file")
    parser.add_argument(
        "--json", action="store_true", help="Emit machine-readable JSON"
    )
    args = parser.parse_args(argv)

    if not args.psd.is_file():
        print("PSD file does not exist or is not a regular file.", file=sys.stderr)
        return 2

    try:
        psd = PSDImage.open(args.psd)
        layers = list(walk_layers(psd))
    except (OSError, ValueError, TypeError) as exc:
        print(f"Failed to read PSD: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(
            json.dumps(
                {
                    "canvas": {"width": psd.width, "height": psd.height},
                    "layers": [asdict(layer) for layer in layers],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    print(f"Canvas: {psd.width} x {psd.height} | layers: {len(layers)}")
    print("Layer order: background to foreground; path indexes are 0-based.")
    for layer in layers:
        path = "/".join(map(str, layer.index_path))
        indent = "  " * (len(layer.index_path) - 1)
        print(
            f"{indent}[{path}] {layer.name!r}"
            f" kind={layer.kind} visible={layer.visible}"
            f" effective={layer.effective_visible} bbox={layer.bbox}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
