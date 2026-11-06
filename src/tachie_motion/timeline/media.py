"""Read exact audio and video durations without touching source media."""

from dataclasses import dataclass
from fractions import Fraction
import json
from pathlib import Path
import subprocess
import wave


@dataclass(frozen=True, slots=True)
class MovieTiming:
    frames: int
    fps: int

    @property
    def duration(self) -> Fraction:
        return Fraction(self.frames, self.fps)


@dataclass(frozen=True, slots=True)
class WaveTiming:
    samples: int
    sample_rate: int

    @property
    def duration(self) -> Fraction:
        return Fraction(self.samples, self.sample_rate)


def probe_movie(path: Path) -> MovieTiming:
    """Inspect exact frame count/rate for a constant-frame-rate MOV."""
    if not path.is_file():
        raise ValueError(f"MOV not found: {path}")
    args = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-count_frames", "-show_entries",
        "stream=nb_read_frames,avg_frame_rate,r_frame_rate",
        "-of", "json", str(path),
    ]
    try:
        result = subprocess.run(args, capture_output=True, check=False)
    except OSError as exc:
        raise RuntimeError(f"Unable to run ffprobe: {exc}") from exc
    if result.returncode:
        raise RuntimeError(
            "ffprobe failed: " + result.stderr.decode("utf-8", "replace")[-1000:]
        )
    try:
        info = json.loads(result.stdout)["streams"][0]
        frames = int(info["nb_read_frames"])
        fps = Fraction(info["avg_frame_rate"])
        exact_rate = Fraction(info["r_frame_rate"])
    except (KeyError, IndexError, ValueError, TypeError, ZeroDivisionError) as exc:
        raise ValueError(f"Missing/invalid MOV timing: {exc}") from exc
    if frames <= 0 or fps <= 0 or fps.denominator != 1 or fps != exact_rate:
        raise ValueError(
            "PoC only supports positive integer constant frame rates"
        )
    if fps.numerator not in (24, 30, 60):
        raise ValueError("PoC only supports 24, 30 or 60 fps")
    return MovieTiming(frames=frames, fps=int(fps))


def probe_wav(path: Path) -> WaveTiming:
    """Read standard uncompressed PCM WAV sample timing precisely."""
    if not path.is_file():
        raise ValueError(f"WAV not found: {path}")
    try:
        with wave.open(str(path), "rb") as reader:
            if reader.getcomptype() != "NONE":
                raise ValueError("PoC only supports uncompressed PCM WAV")
            samples, rate = reader.getnframes(), reader.getframerate()
    except (OSError, EOFError, wave.Error) as exc:
        raise ValueError(f"Invalid PCM WAV: {exc}") from exc
    if samples <= 0 or rate <= 0:
        raise ValueError("WAV must contain positive sample count and sample rate")
    return WaveTiming(samples=samples, sample_rate=rate)
