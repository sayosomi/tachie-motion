"""Alpha-preserving ProRes 4444 encoding from equal-sized RGBA PNG states."""

from collections.abc import Sequence
import os
from pathlib import Path
import subprocess
import tempfile

from PIL import Image


def read_rgba_states(
    paths: Sequence[Path], *, allow_single: bool = False,
) -> tuple[tuple[int, int], list[bytes]]:
    """Load RGBA states; permit one only for a scheduled static sequence.

    Keep the older fixed-hold animation API's two-state contract unchanged.
    """
    if len(paths) < (1 if allow_single else 2):
        raise ValueError("Provide at least two --frame PNGs to test animation")
    frames: list[bytes] = []
    dimensions: tuple[int, int] | None = None
    for path in paths:
        if not path.is_file() or path.suffix.lower() != ".png":
            raise ValueError(f"Not a PNG file: {path}")
        with Image.open(path) as img:
            if "A" not in img.getbands() and "transparency" not in img.info:
                raise ValueError(f"Input PNG has no alpha channel: {path}")
            rgba = img.convert("RGBA")
            if dimensions is None:
                dimensions = rgba.size
                if dimensions[0] < 2 or dimensions[1] < 2:
                    raise ValueError("Image dimensions must be at least 2×2")
                if dimensions[0] % 2:
                    raise ValueError("ProRes requires even image width")
                if dimensions[1] % 2:
                    raise ValueError("ProRes requires even image height")
            if rgba.size != dimensions:
                raise ValueError("All input PNGs must have identical dimensions")
            if rgba.getchannel("A").getextrema() == (255, 255):
                raise ValueError(f"Input PNG is fully opaque: {path}")
            frames.append(rgba.tobytes())
    assert dimensions is not None
    return dimensions, frames


def ffmpeg_args(
    *,
    ffmpeg: str,
    dimensions: tuple[int, int],
    fps: int,
    frame_count: int,
    output: Path,
) -> list[str]:
    """Create an argument list, never a shell command string."""
    if fps not in (24, 30, 60):
        raise ValueError("fps must be 24, 30 or 60")
    if frame_count < 1:
        raise ValueError("frame_count must be positive")
    width, height = dimensions
    return [
        ffmpeg,
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "rawvideo",
        "-pixel_format", "rgba",
        "-video_size", f"{width}x{height}",
        "-framerate", str(fps),
        "-i", "pipe:0",
        "-an",
        "-c:v", "prores_ks",
        "-profile:v", "4444",
        "-pix_fmt", "yuva444p10le",
        "-alpha_bits", "16",
        "-qscale:v", "9",
        "-frames:v", str(frame_count),
        "-f", "mov",
        "-y", str(output),
    ]


def _encode_regular(
    images: list[bytes], dimensions: tuple[int, int],
    *, fps: int, frames_per_state: int, temp: Path, ffmpeg: str,
) -> None:
    """Original raw-frame streaming encoder; also the reuse fallback."""
    args = ffmpeg_args(
        ffmpeg=ffmpeg,
        dimensions=dimensions,
        fps=fps,
        frame_count=len(images) * frames_per_state,
        output=temp,
    )
    try:
        process = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise RuntimeError(f"Could not start FFmpeg: {exc}") from exc

    try:
        assert process.stdin is not None
        for frame in images:
            for _ in range(frames_per_state):
                process.stdin.write(frame)
        process.stdin.close()
        process.stdin = None
        _, errors = process.communicate()
    except BrokenPipeError as exc:
        # Encoder failure can close stdin before the last RGBA frame.
        if process.stdin is not None:
            process.stdin.close()
            process.stdin = None
        _, errors = process.communicate()
        message = errors.decode("utf-8", errors="replace")[-2000:]
        raise RuntimeError(
            f"FFmpeg stopped accepting frames ({process.returncode}): {message}"
        ) from exc
    except Exception:
        if process.poll() is None:
            process.kill()
        if process.stdin is not None:
            process.stdin.close()
            process.stdin = None
        process.communicate()
        raise
    if process.returncode != 0:
        message = errors.decode("utf-8", errors="replace")[-2000:]
        raise RuntimeError(f"FFmpeg failed ({process.returncode}): {message}")


def encode_prores(
    pngs: Sequence[Path],
    output: Path,
    *,
    fps: int = 30,
    frames_per_state: int = 15,
    ffmpeg: str = "ffmpeg",
    ffprobe: str = "ffprobe",
    reuse_packets: bool = False,
):
    """Write a verified ProRes 4444 MOV using an atomic temp file.

    A frame is repeated for a fixed integer count in input order. Existing
    outputs are never overwritten. Each frame is piped, not collected into
    one huge rawvideo buffer. Packet reuse is explicitly opt-in and still
    receives the identical independent full-frame quality verification.
    """
    if frames_per_state <= 0:
        raise ValueError("frames_per_state must be positive")
    if output.suffix.lower() != ".mov":
        raise ValueError("Output must be a .mov path")
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")
    dimensions, images = read_rgba_states(pngs)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=".tachie-prores-", suffix=".mov", dir=output.parent
    )
    os.close(fd)
    temp = Path(temp_name)
    count = len(images) * frames_per_state

    try:
        if reuse_packets:
            from tachie_motion.render.packet_reuse import (
                ReuseUnavailable, encode_reused,
            )
            try:
                encode_reused(
                    images, dimensions, fps=fps, hold=frames_per_state,
                    destination=temp, ffmpeg=ffmpeg, ffprobe=ffprobe,
                )
            except ReuseUnavailable:
                # Optional optimization not supported. Remove partial output
                # and execute the original complete encoder/validator route.
                temp.unlink(missing_ok=True)
                _encode_regular(
                    images, dimensions, fps=fps,
                    frames_per_state=frames_per_state,
                    temp=temp, ffmpeg=ffmpeg,
                )
        else:
            _encode_regular(
                images, dimensions, fps=fps,
                frames_per_state=frames_per_state,
                temp=temp, ffmpeg=ffmpeg,
            )

        # Import only here: encoder implementation and verification stay
        # separately testable.
        from tachie_motion.render.probe import inspect_prores

        report = inspect_prores(
            temp,
            expected_size=dimensions,
            expected_frames=count,
            expected_fps=fps,
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
            source_states=images,
            frames_per_state=frames_per_state,
        )
        # Atomic no-clobber publication: os.replace() could overwrite an
        # output created between exists() and replace(). Linking the fully
        # verified temp file into the same directory fails with EEXIST if
        # another writer wins that race (including dangling symlinks).
        # Do not fall back to an unsafe replace or copy on unsupported FS.
        os.link(temp, output)
        return report
    finally:
        temp.unlink(missing_ok=True)
