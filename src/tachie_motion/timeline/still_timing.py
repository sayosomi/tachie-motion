"""Exact duration-to-frame conversion for static wait intervals (Issue #66)."""

from fractions import Fraction


def wait_frames(duration_seconds: Fraction, fps: int) -> int:
    """Round positive wait seconds to nearest frame; ties up, minimum one.

    The caller must convert any input string/decimal to a rational value
    explicitly. Binary floating-point input is rejected to avoid boundary
    drift or silently rounded decimal durations.
    """
    if not isinstance(duration_seconds, Fraction) or isinstance(
        duration_seconds, bool
    ):
        raise ValueError("Wait duration must be a rational number")
    if duration_seconds <= 0:
        raise ValueError("Wait duration must be positive")
    if type(fps) is not int or fps not in (24, 30, 60):
        raise ValueError("Wait fps must be 24, 30 or 60")
    numerator = duration_seconds.numerator * fps
    denominator = duration_seconds.denominator
    nearest = (2 * numerator + denominator) // (2 * denominator)
    return max(1, nearest)
