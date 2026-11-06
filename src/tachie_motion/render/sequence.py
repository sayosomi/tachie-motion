"""Encode an arbitrary deterministic state sequence to verified ProRes 4444.

The original fixed-hold encoder remains unchanged. This path passes every
video frame's expected source-state index to the independent decode verifier.
Packet reuse is intentionally not enabled for variable-duration schedules.
"""

from collections.abc import Sequence
import os
from pathlib import Path
import subprocess
import tempfile

from tachie_motion.render.prores import ffmpeg_args, read_rgba_states
from tachie_motion.render.probe import ProresReport, inspect_prores


def encode_prores_sequence(
    pngs: Sequence[Path], indices: Sequence[int], output: Path, *,
    fps: int = 30, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe",
) -> ProresReport:
    """Stream scheduled frames and atomically publish only verified media."""
    if output.suffix.lower() != ".mov":
        raise ValueError("Output must have a .mov extension")
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"Output already exists: {output}")
    if not indices:
        raise ValueError("At least one scheduled frame is required")
    # Lip mode "none" is one static PNG repeated over all WAV-driven frames.
    # The fixed-hold PoC still requires two states by default.
    dimensions, states = read_rgba_states(pngs, allow_single=True)
    if any(type(i) is not int or i < 0 or i >= len(states) for i in indices):
        raise ValueError("Scheduled frame refers to an invalid source state")
    args_count = len(indices)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, filename = tempfile.mkstemp(
        prefix=".tachie-sequence-", suffix=".mov", dir=output.parent,
    )
    os.close(fd)
    temp = Path(filename)
    try:
        cmd = ffmpeg_args(
            ffmpeg=ffmpeg, dimensions=dimensions, fps=fps,
            frame_count=args_count, output=temp,
        )
        try:
            proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
        except OSError as exc:
            raise RuntimeError(f"Could not start FFmpeg: {exc}") from exc
        try:
            assert proc.stdin is not None
            for index in indices:
                proc.stdin.write(states[index])
            proc.stdin.close()
            proc.stdin = None
            _, errors = proc.communicate()
        except (BrokenPipeError, OSError) as exc:
            if proc.stdin is not None:
                proc.stdin.close()
                proc.stdin = None
            _, errors = proc.communicate()
            raise RuntimeError(
                "FFmpeg stopped accepting scheduled frames: "
                + errors.decode("utf-8", "replace")[-1500:]
            ) from exc
        except Exception:
            if proc.poll() is None:
                proc.kill()
            if proc.stdin is not None:
                proc.stdin.close()
                proc.stdin = None
            proc.communicate()
            raise
        if proc.returncode != 0:
            raise RuntimeError(
                "FFmpeg scheduled encode failed: "
                + errors.decode("utf-8", "replace")[-1500:]
            )
        report = inspect_prores(
            temp, expected_size=dimensions, expected_frames=args_count,
            expected_fps=fps, ffmpeg=ffmpeg, ffprobe=ffprobe,
            source_states=states, state_indices=indices,
        )
        os.link(temp, output)  # Exclusive and atomic; never replace.
        return report
    finally:
        temp.unlink(missing_ok=True)
