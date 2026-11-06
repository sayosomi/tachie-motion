"""Generate and inspect a single synced MOV/WAV OpenTimelineIO PoC."""

import argparse
from pathlib import Path
import sys

from tachie_motion.timeline.media import probe_movie, probe_wav
from tachie_motion.timeline.otio_json import build_single_utterance, write_otio
from tachie_motion.timeline.test_tone import make_test_tone


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Write 1-video/1-audio OTIO with sample-accurate starts."
    )
    parser.add_argument("--mov", type=Path, required=True)
    audio = parser.add_mutually_exclusive_group(required=True)
    audio.add_argument("--wav", type=Path, help="Use an existing matching WAV")
    audio.add_argument(
        "--test-tone", action="store_true",
        help="Generate an original PCM tone matching MOV duration",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)

    if args.output.suffix.lower() != ".otio":
        parser.error("Output must have .otio extension")
    if args.output.exists():
        parser.error("Output already exists; choose a new OTIO filename")

    try:
        movie = probe_movie(args.mov)
        wav = args.wav
        if args.test_tone:
            wav = args.output.parent / "sync-test-tone.wav"
            if wav.exists():
                parser.error("Test WAV already exists; choose a different output folder")
            make_test_tone(wav, duration=movie.duration)
        assert wav is not None
        audio_timing = probe_wav(wav)
        document = build_single_utterance(args.mov, wav, movie, audio_timing)
        write_otio(document, args.output)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"OTIO PoC failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    print(f"OTIO: {args.output}")
    print(f"V1: {args.mov} | {movie.frames} frames @ {movie.fps} fps")
    print(f"A1: {wav} | {audio_timing.samples} samples @ {audio_timing.sample_rate} Hz")
    print(f"Both clips start at 0 and last {movie.duration} seconds.")
    print("WAV referenced once; MOV referenced once; no media copied.")
    print("Resolve OTIO import and playback: UNTESTED.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
