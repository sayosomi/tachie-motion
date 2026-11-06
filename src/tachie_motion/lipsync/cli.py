"""CLI for a manually bound PSD two-mouth-state WAV-driven render."""

import argparse
from pathlib import Path
import sys

from tachie_motion.lipsync.pipeline import export_mouth_animation


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Create verified alpha MOV and synced OTIO from one PSD and WAV."
    )
    parser.add_argument("--psd", type=Path, required=True)
    parser.add_argument("--wav", type=Path, required=True)
    parser.add_argument("--mouth-closed", required=True, metavar="INDEX_PATH")
    parser.add_argument("--mouth-open", required=True, metavar="INDEX_PATH")
    parser.add_argument("--fps", type=int, default=30, choices=(24, 30, 60))
    parser.add_argument("--open-threshold", type=float, default=0.05)
    parser.add_argument("--close-threshold", type=float, default=0.025)
    parser.add_argument("--padding", type=int, default=16)
    parser.add_argument("--output-mov", type=Path, required=True)
    parser.add_argument("--output-otio", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        result = export_mouth_animation(
            psd=args.psd, wav=args.wav,
            closed_path=args.mouth_closed, open_path=args.mouth_open,
            mov=args.output_mov, otio=args.output_otio, fps=args.fps,
            open_threshold=args.open_threshold,
            close_threshold=args.close_threshold,
            padding=args.padding,
        )
    except (OSError, ValueError, RuntimeError, TypeError) as exc:
        print(
            f"WAV mouth animation failed: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 2

    print(f"MOV: {args.output_mov} ({result.video.frames} frames at {args.fps}fps)")
    print(
        f"WAV: {result.schedule.sample_count} samples at"
        f" {result.schedule.sample_rate} Hz, unmodified"
    )
    print(f"OTIO: {args.output_otio} (one audio reference, zero-aligned)")
    print("All video frames decoded/verified. Mac/Resolve playback: UNTESTED.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
