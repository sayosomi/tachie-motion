"""Generate a deterministic, original, short PCM tone for sync verification."""

from fractions import Fraction
import math
from pathlib import Path
import struct
import wave


def make_test_tone(
    destination: Path, *, duration: Fraction, sample_rate: int = 48000
) -> None:
    """Write one low-volume 440 Hz tone, with fade in/out, without overwrite."""
    count = duration * sample_rate
    if count.denominator != 1 or count.numerator <= 0:
        raise ValueError("Duration is not a positive whole number of WAV samples")
    if count.numerator > sample_rate * 30:
        raise ValueError("Test tone must be at most 30 seconds")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive file creation avoids unintentionally replacing user media.
    with destination.open("xb") as out:
        with wave.open(out, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(sample_rate)
            fade_length = min(480, count.numerator // 2)
            samples = bytearray()
            for i in range(count.numerator):
                fade = min(1.0, (i + 1) / max(1, fade_length),
                           (count.numerator - i) / max(1, fade_length))
                amplitude = round(
                    2400 * fade * math.sin(2 * math.pi * 440 * i / sample_rate)
                )
                samples.extend(struct.pack("<h", amplitude))
            writer.writeframes(samples)
