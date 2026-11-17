"""Integer-exact LAB frame sampling, separate from unfinished mouth-policy choices.

This module does not decide how consonants or devoiced vowels should move a
mouth, or where within a video frame the pose should be sampled. Callers must
supply every policy choice explicitly. Do not enable aiueo exports until the
product owner approves the policy and the renderer is connected.
"""

from dataclasses import dataclass
from typing import Literal

from tachie_motion.audio.lab import LabInterval, SUPPORTED_PHONEMES, TICKS_PER_SECOND

FrameAnchor = Literal["start", "middle", "end"]
ConsonantRule = Literal["rest", "hold_previous", "anticipate_next"]
DevoicedRule = Literal["rest", "vowel"]
AiueoShape = Literal["a", "i", "u", "e", "o", "n"]

_VOWELS = frozenset(("a", "i", "u", "e", "o"))
_REST_PHONEMES = frozenset(("N", "sil", "silB", "silE", "pau", "br"))


@dataclass(frozen=True, slots=True)
class FramePolicy:
    """Required, not defaulted: three unresolved user-facing product decisions."""

    anchor: FrameAnchor
    consonants: ConsonantRule
    devoiced: DevoicedRule

    def __post_init__(self) -> None:
        if self.anchor not in ("start", "middle", "end"):
            raise ValueError("Unsupported video-frame sampling anchor")
        if self.consonants not in ("rest", "hold_previous", "anticipate_next"):
            raise ValueError("Unsupported consonant mouth policy")
        if self.devoiced not in ("rest", "vowel"):
            raise ValueError("Unsupported devoiced-vowel mouth policy")


def _frame_sample_index(frame: int, *, samples: int, sample_rate: int,
                        fps: int, anchor: FrameAnchor) -> int:
    """Choose an actual WAV sample index, never a float or padded video tail."""
    if anchor == "start":
        sample = frame * sample_rate // fps
    elif anchor == "middle":
        sample = (2 * frame + 1) * sample_rate // (2 * fps)
    else:
        sample = ((frame + 1) * sample_rate + fps - 1) // fps - 1
    return min(samples - 1, sample)


def phonemes_by_frame(
    intervals: tuple[LabInterval, ...], *,
    samples: int, sample_rate: int, fps: int, anchor: FrameAnchor,
) -> tuple[str | None, ...]:
    """Return exact LAB phone at the selected WAV sample for each video frame.

    None denotes a LAB gap. Even the final, padded video frame samples only
    within the real PCM. This function deliberately does not infer a vowel.
    """
    if any(type(value) is not int or value <= 0 for value in (samples, sample_rate, fps)):
        raise ValueError("WAV timing and FPS must be positive integers")
    if anchor not in ("start", "middle", "end"):
        raise ValueError("Unsupported video-frame sampling anchor")
    if not isinstance(intervals, tuple) or not intervals:
        raise ValueError("A validated LAB interval tuple is required")
    previous_end = 0
    for item in intervals:
        if not isinstance(item, LabInterval) or any(
            type(value) is not int for value in (item.start_tick, item.end_tick)
        ):
            raise ValueError("Invalid LAB interval")
        if (item.start_tick < previous_end or item.start_tick >= item.end_tick
                or item.end_tick * sample_rate > samples * TICKS_PER_SECOND
                or item.phoneme not in SUPPORTED_PHONEMES):
            raise ValueError("Unvalidated LAB interval sequence")
        previous_end = item.end_tick

    frame_count = (samples * fps + sample_rate - 1) // sample_rate
    result: list[str | None] = []
    position = 0
    for frame in range(frame_count):
        sample = _frame_sample_index(
            frame, samples=samples, sample_rate=sample_rate,
            fps=fps, anchor=anchor,
        )
        tick = sample * TICKS_PER_SECOND // sample_rate
        while position < len(intervals) and intervals[position].end_tick <= tick:
            position += 1
        current = intervals[position] if position < len(intervals) else None
        result.append(current.phoneme if current and current.start_tick <= tick else None)
    return tuple(result)


def _classify(phone: str | None, policy: FramePolicy) -> tuple[str, AiueoShape | None]:
    if phone is None or phone in _REST_PHONEMES:
        return "rest", None
    if phone not in SUPPORTED_PHONEMES:
        raise ValueError("Unsupported LAB phoneme")
    if phone in _VOWELS:
        return "vowel", phone  # type: ignore[return-value]
    if phone in ("A", "I", "U", "E", "O"):
        if policy.devoiced == "vowel":
            return "vowel", phone.lower()  # type: ignore[return-value]
        return "rest", None
    return "consonant", None


def shapes_by_frame(
    phones: tuple[str | None, ...], *, policy: FramePolicy,
) -> tuple[AiueoShape, ...]:
    """Evaluate ALL offered policies; callers must explicitly select one.

    A phoneme gap, LAB pause/silence, or Japanese moraic nasal N is rest (n).
    Consonant behavior and devoiced-vowel behavior are NOT yet product choices.
    """
    if not isinstance(policy, FramePolicy) or not isinstance(phones, tuple):
        raise ValueError("An explicit frame policy and phoneme sequence are required")
    classified = tuple(_classify(phone, policy) for phone in phones)
    following: list[AiueoShape | None] = [None] * len(classified)
    next_vowel: AiueoShape | None = None
    for i in range(len(classified) - 1, -1, -1):
        kind, vowel = classified[i]
        if kind == "rest":
            next_vowel = None
        elif kind == "vowel":
            next_vowel = vowel
        else:
            following[i] = next_vowel

    result: list[AiueoShape] = []
    previous: AiueoShape | None = None
    for i, (kind, vowel) in enumerate(classified):
        if kind == "vowel":
            previous = vowel
            result.append(vowel if vowel is not None else "n")
        elif kind == "rest":
            previous = None
            result.append("n")
        elif policy.consonants == "hold_previous":
            result.append(previous or "n")
        elif policy.consonants == "anticipate_next":
            result.append(following[i] or "n")
        else:
            result.append("n")
    return tuple(result)


def schedule_aiueo(
    intervals: tuple[LabInterval, ...], *,
    samples: int, sample_rate: int, fps: int, policy: FramePolicy,
) -> tuple[AiueoShape, ...]:
    """Build a reproducible six-pose sequence with no implicit mapping policy."""
    if not isinstance(policy, FramePolicy):
        raise ValueError("Explicit frame policy required")
    phones = phonemes_by_frame(
        intervals, samples=samples, sample_rate=sample_rate,
        fps=fps, anchor=policy.anchor,
    )
    return shapes_by_frame(phones, policy=policy)
