"""Independently inspect ProRes metadata and validate every decoded RGBA frame."""

from dataclasses import dataclass
from fractions import Fraction
import json
from pathlib import Path
import subprocess
from collections.abc import Sequence

from tachie_motion.render.frame_validation import verify_decoded_frames


@dataclass(frozen=True, slots=True)
class ProresReport:
    codec: str
    profile: str
    pixel_format: str
    width: int
    height: int
    fps: str
    frames: int
    alpha_min: int
    alpha_max: int
    decoded_frames: int
    max_alpha_mean_error: float
    max_rgb_mean_error: float
    changed_tiles: int
    max_changed_tile_alpha_error: float
    max_changed_tile_rgb_error: float
    max_block_alpha_pixels: int
    max_block_rgb_pixels: int


def _capture(args: list[str]) -> bytes:
    try:
        result = subprocess.run(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
        )
    except OSError as exc:
        raise RuntimeError(f"Could not start media inspection tool: {exc}") from exc
    if result.returncode:
        message = result.stderr.decode("utf-8", "replace")[-2000:]
        raise RuntimeError(f"Media inspection failed: {message}")
    return result.stdout


def inspect_prores(
    video: Path,
    *,
    expected_size: tuple[int, int],
    expected_frames: int,
    expected_fps: int,
    ffmpeg: str = "ffmpeg",
    ffprobe: str = "ffprobe",
    source_states: Sequence[bytes] | None = None,
    frames_per_state: int = 0,
    state_indices: Sequence[int] | None = None,
) -> ProresReport:
    """Check stream metadata, decode every frame, and compare with source if supplied.

    ProRes RGB is lossy: frame checks use per-state bounded mean error.
    Editor edge/alpha interpretation still needs a human import check.
    """
    data = _capture([
        ffprobe,
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries",
        "stream=codec_name,profile,pix_fmt,width,height,nb_frames,r_frame_rate",
        "-of", "json",
        str(video),
    ])
    try:
        streams = json.loads(data)["streams"]
        stream = streams[0]
        codec = str(stream["codec_name"])
        profile = str(stream["profile"])
        pixel = str(stream["pix_fmt"])
        width, height = int(stream["width"]), int(stream["height"])
        fps = str(stream["r_frame_rate"])
    except (KeyError, IndexError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Incomplete ffprobe video stream report: {exc}") from exc

    # Most MOVs contain an exact sample count in their metadata. Reading
    # nb_frames does not require ffprobe to scan and decode the entire file.
    # If absent or inconsistent, retain the previous counted-frame check.
    try:
        frames = int(stream.get("nb_frames"))
        if frames < 1:
            raise ValueError("Non-positive metadata frame count")
    except (ValueError, TypeError):
        frames = None
    if frames != expected_frames:
        counted = _capture([
            ffprobe,
            "-v", "error",
            "-select_streams", "v:0",
            "-count_frames",
            "-show_entries", "stream=nb_read_frames",
            "-of", "json",
            str(video),
        ])
        try:
            frames = int(json.loads(counted)["streams"][0]["nb_read_frames"])
        except (KeyError, IndexError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Incomplete counted-frame ffprobe report: {exc}") from exc

    if codec != "prores" or "4444" not in profile:
        raise RuntimeError(f"Expected ProRes 4444; got {codec!r} / {profile!r}")
    if not pixel.startswith("yuva444p"):
        raise RuntimeError(f"Output does not report an alpha pixel format: {pixel}")
    if (width, height) != expected_size:
        raise RuntimeError(f"Frame size changed: {(width, height)} != {expected_size}")
    if frames != expected_frames:
        raise RuntimeError(f"Frame count changed: {frames} != {expected_frames}")
    try:
        rate = Fraction(fps)
    except (ValueError, ZeroDivisionError) as exc:
        raise RuntimeError(f"Invalid encoded frame rate {fps!r}") from exc
    if rate != expected_fps:
        raise RuntimeError(f"Unexpected encoded frame rate: {fps} != {expected_fps}")

    (
        decoded, minimum, maximum, alpha_error, rgb_error,
        changed_tiles, local_alpha_error, local_rgb_error,
        block_alpha, block_rgb,
    ) = verify_decoded_frames(
        video,
        dimensions=(width, height),
        count=frames,
        ffmpeg=ffmpeg,
        source_states=source_states,
        frames_per_state=frames_per_state,
        state_indices=state_indices,
    )

    return ProresReport(
        codec=codec,
        profile=profile,
        pixel_format=pixel,
        width=width,
        height=height,
        fps=fps,
        frames=frames,
        alpha_min=minimum,
        alpha_max=maximum,
        decoded_frames=decoded,
        max_alpha_mean_error=alpha_error,
        max_rgb_mean_error=rgb_error,
        changed_tiles=changed_tiles,
        max_changed_tile_alpha_error=local_alpha_error,
        max_changed_tile_rgb_error=local_rgb_error,
        max_block_alpha_pixels=block_alpha,
        max_block_rgb_pixels=block_rgb,
    )
