"""Generate a deterministic mouth-state JSON schedule from a PCM WAV."""

import argparse
from pathlib import Path
import sys

from tachie_motion.audio.volume import analyze_wav, write_schedule_json


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Analyze WAV volume at video frame boundaries; output open/closed JSON."
    )
    parser.add_argument("--wav", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fps", type=int, choices=(24, 30, 60), default=30)
    parser.add_argument("--open-threshold", type=float, default=0.05)
    parser.add_argument("--close-threshold", type=float, default=0.025)
    args = parser.parse_args(argv)
    try:
        schedule = analyze_wav(
            args.wav, fps=args.fps,
            open_threshold=args.open_threshold,
            close_threshold=args.close_threshold,
        )
        write_schedule_json(schedule, args.output)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"WAV mouth schedule failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    print(
        f"Schedule: {args.output} | {len(schedule.frames)} frames @ {schedule.fps} fps"
        f" | WAV samples={schedule.sample_count} rate={schedule.sample_rate}"
    )
    print("PSD, MOV, OTIO and Resolve export: NOT IMPLEMENTED by this CLI.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
