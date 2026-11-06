"""Stream and compare every decoded ProRes frame to its source RGBA state.

Frames are processed one-by-one; an entire high-resolution MOV is never
buffered in Python memory. ProRes color is lossy, so use bounded mean
absolute error on visible RGB, and alpha over the complete image.
"""

from collections.abc import Sequence
from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageChops, ImageStat

from tachie_motion.render.change_regions import build_change_tiles, check_changed_tiles
from tachie_motion.render.block_integrity import check_frame_blocks


def _read_exact(stream, count: int) -> bytes:
    result = bytearray(count)
    view = memoryview(result)
    done = 0
    while done < count:
        read = stream.readinto(view[done:])
        if not read:
            break
        done += read
    if done != count:
        raise RuntimeError(
            f"Video decoder stopped early: got {done} of {count} frame bytes"
        )
    return bytes(result)


def verify_decoded_frames(
    video: Path,
    *,
    dimensions: tuple[int, int],
    count: int,
    ffmpeg: str,
    source_states: Sequence[bytes] | None = None,
    frames_per_state: int = 0,
    state_indices: Sequence[int] | None = None,
    max_alpha_mean_error: float = 3.0,
    max_rgb_mean_error: float = 20.0,
) -> tuple[int, int, int, float, float, int, float, float, int, int]:
    """Decode every frame and check per-frame alpha + source-state fidelity.

    Color is checked over source pixels with alpha>=128 (visible pixels);
    all pixels count toward alpha error. If no source states are supplied,
    every frame is still decoded and verified to have nontrivial alpha.
    """
    if count < 1:
        raise ValueError("Expected frame count must be positive")
    if state_indices is not None:
        if (
            source_states is None
            or frames_per_state != 0
            or len(state_indices) != count
            or any(
                type(index) is not int or not 0 <= index < len(source_states)
                for index in state_indices
            )
        ):
            raise ValueError("Invalid per-frame source-state indices")
    elif source_states is not None and (
        frames_per_state < 1 or len(source_states) * frames_per_state != count
    ):
        raise ValueError("Source state frame count does not match MOV")
    width, height = dimensions
    frame_bytes = width * height * 4
    min_alpha, max_alpha = 255, 0
    peak_alpha_error, peak_rgb_error = 0.0, 0.0
    peak_local_alpha, peak_local_rgb = 0.0, 0.0
    peak_block_alpha, peak_block_rgb = 0, 0
    tiles = (
        build_change_tiles(source_states, dimensions)
        if source_states is not None else []
    )
    expected_images = (
        [Image.frombytes("RGBA", dimensions, frame) for frame in source_states]
        if source_states is not None else []
    )
    decoded = 0
    last_decoded: bytes | None = None
    last_state_index: int | None = None
    args = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", str(video), "-map", "0:v:0",
        "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
    ]
    with tempfile.TemporaryFile() as errors:
        try:
            proc = subprocess.Popen(
                args, stdout=subprocess.PIPE, stderr=errors
            )
        except OSError as exc:
            raise RuntimeError(f"Unable to start FFmpeg decoder: {exc}") from exc
        try:
            assert proc.stdout is not None
            for index in range(count):
                raw_frame = _read_exact(proc.stdout, frame_bytes)
                state_index = (
                    state_indices[index] if state_indices is not None
                    else (index // frames_per_state if source_states is not None else None)
                )
                # Every frame is still decoded and compared byte-for-byte.
                # If the RGBA bytes AND expected state match the previously
                # validated frame, all fidelity checks would have exactly
                # the same results. Reuse that proof without rescanning
                # millions of pixels for each repeated animation hold.
                # A single corrupted frame cannot pass this comparison.
                if (
                    last_decoded is not None
                    and state_index == last_state_index
                    and raw_frame == last_decoded
                ):
                    decoded += 1
                    continue
                last_decoded, last_state_index = raw_frame, state_index
                actual = Image.frombytes("RGBA", dimensions, raw_frame)
                alpha = actual.getchannel("A")
                minimum, maximum = alpha.getextrema()
                min_alpha = min(min_alpha, minimum)
                max_alpha = max(max_alpha, maximum)
                if minimum == 255 or maximum == 0:
                    raise RuntimeError(
                        f"Decoded frame {index}: alpha lost or fully transparent"
                    )
                if source_states is not None:
                    assert state_index is not None
                    original = expected_images[state_index]
                    original_alpha = original.getchannel("A")
                    alpha_diff = ImageChops.difference(alpha, original_alpha)
                    alpha_error = ImageStat.Stat(alpha_diff).mean[0]
                    peak_alpha_error = max(peak_alpha_error, alpha_error)
                    if alpha_error > max_alpha_mean_error:
                        raise RuntimeError(
                            f"Decoded frame {index}: alpha fidelity mismatch"
                            f" (MAE={alpha_error:.3f})"
                        )
                    visible = original_alpha.point(
                        lambda value: 255 if value >= 128 else 0
                    )
                    if visible.getbbox() is not None:
                        rgb_diff = ImageChops.difference(
                            actual.convert("RGB"), original.convert("RGB")
                        )
                        rgb_error = max(ImageStat.Stat(rgb_diff, mask=visible).mean)
                        peak_rgb_error = max(peak_rgb_error, rgb_error)
                        if rgb_error > max_rgb_mean_error:
                            raise RuntimeError(
                                f"Decoded frame {index}: RGB content mismatch"
                                f" (MAE={rgb_error:.3f})"
                            )
                    # F-06/F-07: full-frame block checks also cover
                    # invariant semi-transparent objects, low-alpha color
                    # changes, and outlines far outside change-tile halos.
                    block_alpha, block_rgb = check_frame_blocks(
                        actual, original, frame_index=index
                    )
                    peak_block_alpha = max(peak_block_alpha, block_alpha)
                    peak_block_rgb = max(peak_block_rgb, block_rgb)
                    # F-05: ensure a tiny changing mouth/eye is not diluted by
                    # a large unchanged body in the whole-frame mean.
                    local_alpha, local_rgb = check_changed_tiles(
                        actual, original, tiles, frame_index=index
                    )
                    peak_local_alpha = max(peak_local_alpha, local_alpha)
                    peak_local_rgb = max(peak_local_rgb, local_rgb)
                decoded += 1
            # An additional decoded frame would mean metadata and stream disagree.
            if proc.stdout.read(1):
                raise RuntimeError("Decoded more frames than expected")
            proc.stdout.close()
            ret = proc.wait()
            if ret:
                errors.seek(0)
                err = errors.read().decode("utf-8", "replace")[-2000:]
                raise RuntimeError(f"FFmpeg decode failed ({ret}): {err}")
        except Exception:
            if proc.poll() is None:
                proc.kill()
            if proc.stdout is not None and not proc.stdout.closed:
                proc.stdout.close()
            proc.wait()
            raise
    return (
        decoded, min_alpha, max_alpha,
        peak_alpha_error, peak_rgb_error,
        len(tiles), peak_local_alpha, peak_local_rgb,
        peak_block_alpha, peak_block_rgb,
    )
