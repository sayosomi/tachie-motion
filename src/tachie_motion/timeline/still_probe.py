"""Read-only still-image OTIO/Resolve compatibility probe for Issue #66.

This is an isolated PoC, not the product's media publication path.
"""

import argparse
from fractions import Fraction
from pathlib import Path

from PIL import Image, ImageDraw

from tachie_motion.timeline.otio_json import _range, _time, _track, write_otio
from tachie_motion.timeline.still_timing import wait_frames

SUPPORTED_FPS = (24, 30, 60)
FRACTIONAL_WAIT = Fraction(51, 50)  # 1.02 seconds, noninteger frames at all rates.


def build_still_timeline(image: Path, fps: int, frames: tuple[int, ...]) -> dict:
    """Reference one unchanged RGBA PNG for one or more timed video clips."""
    if fps not in SUPPORTED_FPS:
        raise ValueError("Unsupported fps")
    if not frames or len(frames) > 16 or any(
        not isinstance(n, int) or isinstance(n, bool) or n <= 0 for n in frames
    ):
        raise ValueError("Invalid frame counts")
    if image.suffix.lower() != ".png" or image.is_symlink() or not image.is_file():
        raise ValueError("An existing regular PNG file is required")
    # Ensure the experiment really tests alpha, not a fully opaque RGB image.
    with Image.open(image) as source:
        if source.format != "PNG" or source.mode != "RGBA":
            raise ValueError("Probe requires an RGBA PNG")
        if source.getchannel("A").getextrema()[0] == 255:
            raise ValueError("Probe requires transparent pixels")

    path = str(image.resolve(strict=True))
    video_clips = []
    for n in frames:
        video_clips.append({
            "OTIO_SCHEMA": "Clip.2",
            "name": image.name,
            "metadata": {},
            "source_range": _range(n, fps),
            "effects": [],
            "markers": [],
            "enabled": True,
            "media_references": {
                "DEFAULT_MEDIA": {
                    "OTIO_SCHEMA": "ExternalReference.1",
                    "name": image.name,
                    "metadata": {},
                    "available_range": _range(1, fps),
                    "available_image_bounds": None,
                    "target_url": path,
                }
            },
            "active_media_reference_key": "DEFAULT_MEDIA",
        })
    total_frames = sum(frames)
    audio_gap = {
        "OTIO_SCHEMA": "Gap.1",
        "name": "",
        "metadata": {},
        "source_range": _range(total_frames, fps),
        "effects": [],
        "markers": [],
        "enabled": True,
    }
    video_track = _track("Video 1", "Video", video_clips[0])
    video_track["children"] = video_clips
    return {
        "OTIO_SCHEMA": "Timeline.1",
        "name": "tachie-motion still PNG probe",
        "metadata": {},
        "global_start_time": _time(0, fps),
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "name": "tracks",
            "metadata": {},
            "source_range": None,
            "effects": [],
            "markers": [],
            "enabled": True,
            "children": [
                video_track,
                _track("Audio 1", "Audio", audio_gap),
            ],
        },
    }


def create_synthetic_png(path: Path) -> None:
    """Non-symmetric synthetic artwork, with clear edges and partial alpha."""
    art = Image.new("RGBA", (320, 240), (0, 0, 0, 0))
    draw = ImageDraw.Draw(art)
    draw.rectangle((20, 30, 150, 200), fill=(240, 80, 40, 255))
    draw.rectangle((150, 60, 300, 180), fill=(40, 130, 240, 128))
    draw.ellipse((65, 80, 115, 130), fill=(20, 20, 20, 255))
    # Exclusive creation: never overwrite a user's existing image.
    with path.open("xb") as output:
        art.save(output, format="PNG")


def generate_probes(folder: Path, image: Path | None = None) -> list[tuple[Path, int, tuple[int, ...]]]:
    """Write exact and floor/ceil fractional-duration tests, plus PNG reuse."""
    folder.mkdir(parents=True, exist_ok=True)
    if image is None:
        image = folder / "合成 立ち絵 e\u0301.png"
        create_synthetic_png(image)
    results = []
    for fps in SUPPORTED_FPS:
        requested = FRACTIONAL_WAIT * fps
        floor_frames = requested.numerator // requested.denominator
        ceil_frames = -(-requested.numerator // requested.denominator)
        cases = (
            (f"still_{fps}fps_2s.otio", (2 * fps,)),
            (f"still_{fps}fps_1p02s_floor.otio", (floor_frames,)),
            (f"still_{fps}fps_1p02s_ceil.otio", (ceil_frames,)),
            (f"still_{fps}fps_1p02s_nearest.otio", (wait_frames(FRACTIONAL_WAIT, fps),)),
        )
        for filename, frames in cases:
            document = build_still_timeline(image, fps, frames)
            output = folder / filename
            write_otio(document, output)
            results.append((output, fps, frames))
    output = folder / "still_30fps_repeat.otio"
    frames = (30, 60)
    write_otio(build_still_timeline(image, 30, frames), output)
    results.append((output, 30, frames))
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Issue #66: transparent PNG OTIO probe")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--image", type=Path, help="existing RGBA PNG (read-only)")
    args = parser.parse_args()
    for output, fps, frames in generate_probes(args.output_dir, args.image):
        print(f"{output}: {sum(frames)} frames / {fps}fps = {Fraction(sum(frames), fps)}s")


if __name__ == "__main__":
    main()
