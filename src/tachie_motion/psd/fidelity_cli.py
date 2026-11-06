"""Read-only report of PSD features that need Photoshop fidelity checks."""

import argparse
from pathlib import Path
import sys

from psd_tools import PSDImage

from tachie_motion.psd.fidelity import find_fidelity_risks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report PSD blend/mask/clipping/effect fidelity risks."
    )
    parser.add_argument("psd", type=Path, help="Source PSD")
    args = parser.parse_args(argv)
    if not args.psd.is_file():
        parser.error("PSD does not exist or is not a regular file")
    try:
        psd = PSDImage.open(args.psd)
        risks = list(find_fidelity_risks(psd))
    except (OSError, TypeError, ValueError, RuntimeError) as exc:
        print(f"PSD fidelity diagnostics failed: {exc}", file=sys.stderr)
        return 2

    if not risks:
        print("No known complex features flagged by the basic diagnostic.")
        print("Not a Photoshop pixel-fidelity guarantee.")
        return 0
    print(f"Potential compositor fidelity risks: {len(risks)}")
    for risk in risks:
        path = "/".join(map(str, risk.index_path))
        print(f"[{path}] {risk.layer_name!r}: {risk.feature} — {risk.detail}")
    print("Compare exported RGBA against a trusted Photoshop merged preview.")
    print("No PSD was saved or modified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
