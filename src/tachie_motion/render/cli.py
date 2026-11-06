"""A short two-state ProRes 4444 MOV for the local Phase 0 proof of concept."""

import argparse
from pathlib import Path
import sys

from tachie_motion.render.prores import encode_prores


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Encode and verify short transparent ProRes 4444 from RGBA PNGs."
    )
    parser.add_argument(
        "--frame",
        type=Path,
        action="append",
        required=True,
        help="RGBA PNG for each animation state (repeat at least twice)",
    )
    parser.add_argument("--fps", type=int, choices=(24, 30, 60), default=30)
    parser.add_argument(
        "--frames-per-state",
        type=int,
        default=15,
        help="Repeat each PNG for this many frames (default: 15)",
    )
    parser.add_argument(
        "--reuse-packets", action="store_true",
        help="Opt in to repeated ProRes key-packet reuse (still fully verifies)",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        report = encode_prores(
            args.frame,
            args.output,
            fps=args.fps,
            frames_per_state=args.frames_per_state,
            reuse_packets=args.reuse_packets,
        )
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"ProRes PoC failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    print(f"MOV: {args.output}")
    print(
        f"Verified: codec={report.codec}, profile={report.profile},"
        f" pix_fmt={report.pixel_format}"
    )
    print(
        f"Video: {report.width}x{report.height}, fps={report.fps},"
        f" frames={report.frames}"
    )
    print(
        f"Decoded {report.decoded_frames}/{report.frames} frames,"
        f" alpha min={report.alpha_min} max={report.alpha_max}"
    )
    print(
        f"Worst-frame mean error: alpha={report.max_alpha_mean_error:.3f}"
        f" RGB={report.max_rgb_mean_error:.3f}"
    )
    print(
        f"Changed-region checks: {report.changed_tiles} tiles;"
        f" max alpha MAE={report.max_changed_tile_alpha_error:.3f}"
        f" max RGB MAE={report.max_changed_tile_rgb_error:.3f}"
    )
    print(
        f"Full-frame 8x8 integrity: peak bad alpha pixels="
        f"{report.max_block_alpha_pixels}/64,"
        f" RGB={report.max_block_rgb_pixels}/64 (limit <8)"
    )
    print("Automated all-frame, full-frame block and changed-region checks: PASS.")
    print("Resolve transparency, edges and placement: UNTESTED.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
