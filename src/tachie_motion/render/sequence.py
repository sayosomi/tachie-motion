"""Encode an arbitrary deterministic state sequence to verified ProRes 4444.

The original fixed-hold encoder remains unchanged. This path passes every
video frame's expected source-state index to the independent decode verifier.
Packet reuse is intentionally not enabled for variable-duration schedules.
"""

from collections.abc import Callable, Sequence
import os
from pathlib import Path
import subprocess
import tempfile

from tachie_motion.render.prores import ffmpeg_args, read_rgba_states
from tachie_motion.render.cancel_monitor import ProcessCancelWatcher
from tachie_motion.render.probe import ProresReport, inspect_prores


def encode_prores_sequence(
    pngs: Sequence[Path], indices: Sequence[int], output: Path, *,
    fps: int = 30, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe",
    on_frame: Callable[[int, int], None] | None = None,
    on_verify: Callable[[], None] | None = None,
    check_cancel: Callable[[], None] | None = None,
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
        with ProcessCancelWatcher(proc, check_cancel) as watcher:
            try:
                assert proc.stdin is not None
                tick = max(1, args_count // 100)
                for number, index in enumerate(indices, 1):
                    watcher.check()
                    proc.stdin.write(states[index])
                    if on_frame and (number % tick == 0 or number == args_count):
                        on_frame(number, args_count)
                proc.stdin.close()
                proc.stdin = None
                while True:
                    try:
                        _, errors = proc.communicate(timeout=0.2)
                        break
                    except subprocess.TimeoutExpired:
                        watcher.check()
                watcher.check()
            except (BrokenPipeError, OSError) as exc:
                # An interrupted pipe may raise before the normal cancellation
                # checkpoint. Reap the killed child *before* raising the token
                # cancellation, otherwise a zombie FFmpeg can be left behind.
                if proc.poll() is None:
                    proc.kill()
                if proc.stdin is not None:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass
                    proc.stdin = None
                _, errors = proc.communicate()
                watcher.check()
                raise RuntimeError(
                    "FFmpeg stopped accepting scheduled frames: "
                    + errors.decode("utf-8", "replace")[-1500:]
                ) from exc
            except BaseException:
                if proc.poll() is None:
                    proc.kill()
                if proc.stdin is not None:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass
                    proc.stdin = None
                proc.communicate()
                watcher.check()
                raise
        if proc.returncode != 0:
            raise RuntimeError(
                "FFmpeg scheduled encode failed: "
                + errors.decode("utf-8", "replace")[-1500:]
            )
        if check_cancel:
            check_cancel()
        if on_verify:
            on_verify()
        report = inspect_prores(
            temp, expected_size=dimensions, expected_frames=args_count,
            expected_fps=fps, ffmpeg=ffmpeg, ffprobe=ffprobe,
            source_states=states, state_indices=indices,
            check_cancel=check_cancel,
        )
        if check_cancel:
            check_cancel()
        os.link(temp, output)  # Exclusive and atomic; never replace.
        return report
    finally:
        temp.unlink(missing_ok=True)
