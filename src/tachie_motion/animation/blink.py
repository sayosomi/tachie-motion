"""Deterministic closed-eye frame scheduling, independent of PSD and WAV I/O.

All durations and offsets are explicit integer frame counts. No user-facing
defaults are defined here: those are a separate, pending product decision.
"""

from hashlib import sha256


def _jitter_offset(seed: int, event_index: int, width: int) -> int:
    """Produce a stable, bounded variation without global RNG state."""
    if width == 0:
        return 0
    data = f"{seed}:{event_index}".encode("ascii")
    value = int.from_bytes(sha256(data).digest()[:8], "big")
    return value % (2 * width + 1) - width


def schedule_blink_frames(
    *,
    frame_count: int,
    interval_frames: int,
    closed_frames: int,
    jitter_frames: int,
    phase_frames: int,
    seed: int,
) -> tuple[bool, ...]:
    """Mark closed-eye video frames with a deterministic sequence.

    The first blink starts at `phase_frames`. Subsequent starts are
    `interval_frames +/- jitter_frames` apart. One open frame is required
    between consecutive blinks. A blink crossing the final frame is clipped.
    Neither FPS conversion nor visual pose selection is performed here.
    """
    args = (frame_count, interval_frames, closed_frames,
            jitter_frames, phase_frames, seed)
    if any(type(value) is not int for value in args):
        raise ValueError("Blink frame parameters and seed must be integers")
    if frame_count < 0 or interval_frames < 1 or closed_frames < 1:
        raise ValueError("Invalid blink frame count, interval or closed duration")
    if jitter_frames < 0 or phase_frames < 0:
        raise ValueError("Blink jitter and initial phase cannot be negative")
    if closed_frames >= interval_frames - jitter_frames:
        raise ValueError("Blink interval must leave an open frame between blinks")

    closed = [False] * frame_count
    start = phase_frames
    event = 0
    while start < frame_count:
        end = min(frame_count, start + closed_frames)
        closed[start:end] = [True] * (end - start)
        start += interval_frames + _jitter_offset(seed, event, jitter_frames)
        event += 1
    return tuple(closed)


def compose_mouth_eye_indices(
    mouth_indices: tuple[int, ...],
    eye_closed: tuple[bool, ...],
    *,
    mouth_pose_count: int,
) -> tuple[int, ...]:
    """Map independent lip and blink frames to a two-pose-per-mouth PNG grid.

    Each mouth pose has an open-eye image at even index and a closed-eye image
    at the following odd index. The caller must render that exact ordering.
    """
    if type(mouth_pose_count) is not int or mouth_pose_count < 1:
        raise ValueError("Invalid mouth pose count")
    if len(mouth_indices) != len(eye_closed):
        raise ValueError("Lip and blink frame counts disagree")
    result = []
    for mouth, closed in zip(mouth_indices, eye_closed):
        if (type(mouth) is not int or not 0 <= mouth < mouth_pose_count
                or type(closed) is not bool):
            raise ValueError("Invalid lip or blink frame")
        result.append(2 * mouth + int(closed))
    return tuple(result)
