"""Deterministic per-video-frame volume and two-state mouth schedules for PCM WAV."""

from collections.abc import Iterable
from dataclasses import dataclass
import math
import os
from pathlib import Path
import tempfile
import wave

import numpy as np

from tachie_motion.audio.wav_integrity import validate_pcm_header


@dataclass(frozen=True, slots=True)
class MouthFrame:
    index: int
    start_sample: int
    end_sample: int
    rms: float
    mouth: str


@dataclass(frozen=True, slots=True)
class VolumeSchedule:
    sample_rate: int
    channels: int
    sample_width_bits: int
    sample_count: int
    fps: int
    open_threshold: float
    close_threshold: float
    frames: tuple[MouthFrame, ...]

    def as_dict(self) -> dict:
        """Versioned, path-free data for CLI and future renderer consumers."""
        return {
            "schema_version": 1,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "sample_width_bits": self.sample_width_bits,
            "sample_count": self.sample_count,
            "fps": self.fps,
            "frame_count": len(self.frames),
            "open_threshold": self.open_threshold,
            "close_threshold": self.close_threshold,
            "frames": [
                {
                    "index": frame.index,
                    "start_sample": frame.start_sample,
                    "end_sample": frame.end_sample,
                    "rms": frame.rms,
                    "mouth": frame.mouth,
                }
                for frame in self.frames
            ],
        }


def _validate_thresholds(open_threshold: float, close_threshold: float) -> None:
    if not (
        math.isfinite(open_threshold)
        and math.isfinite(close_threshold)
        and 0 < close_threshold <= open_threshold <= 1
    ):
        raise ValueError("Thresholds must satisfy 0 < close <= open <= 1")


def gate_levels(
    levels: Iterable[float], *, open_threshold: float = 0.05,
    close_threshold: float = 0.025,
) -> tuple[str, ...]:
    """Pure hysteresis gate; equality opens and equality does not close."""
    _validate_thresholds(open_threshold, close_threshold)
    opened = False
    states: list[str] = []
    for level in levels:
        if not math.isfinite(level) or not 0 <= level <= 1:
            raise ValueError("RMS levels must be finite and between 0 and 1")
        if opened:
            if level < close_threshold:
                opened = False
        elif level >= open_threshold:
            opened = True
        states.append("open" if opened else "closed")
    return tuple(states)


def _normalized_pcm(payload: bytes, sample_width: int) -> np.ndarray:
    """Decode interleaved little-endian integer PCM into normalized float64."""
    if sample_width == 1:
        return (np.frombuffer(payload, dtype=np.uint8).astype(np.float64) - 128) / 128
    if sample_width == 2:
        return np.frombuffer(payload, dtype="<i2").astype(np.float64) / 32768
    if sample_width == 3:
        octets = np.frombuffer(payload, dtype=np.uint8).reshape(-1, 3)
        signed = (
            octets[:, 0].astype(np.int32)
            | (octets[:, 1].astype(np.int32) << 8)
            | (octets[:, 2].astype(np.int32) << 16)
        )
        signed = (signed ^ 0x800000) - 0x800000
        return signed.astype(np.float64) / 8388608
    if sample_width == 4:
        return np.frombuffer(payload, dtype="<i4").astype(np.float64) / 2147483648
    raise ValueError("Only 8/16/24/32-bit integer PCM WAV is supported")


def _ceil_div(numerator: int, denominator: int) -> int:
    return (numerator + denominator - 1) // denominator


def analyze_wav(
    path: Path, *, fps: int = 30,
    open_threshold: float = 0.05, close_threshold: float = 0.025,
) -> VolumeSchedule:
    """Analyze consecutive sample windows without loading the whole WAV.

    The WAV's exact sample count is authoritative. Video frame count is the
    ceiling of sample duration in frames, so the final frame may be partial.
    Channels contribute energy independently; opposing stereo signals cannot
    cancel before RMS measurement.
    """
    if fps not in (24, 30, 60):
        raise ValueError("fps must be 24, 30 or 60")
    _validate_thresholds(open_threshold, close_threshold)
    if not path.is_file():
        raise ValueError("WAV does not exist or is not a file")

    levels: list[tuple[int, int, float]] = []
    try:
        with wave.open(str(path), "rb") as reader:
            if reader.getcomptype() != "NONE":
                raise ValueError("Only uncompressed integer PCM WAV is supported")
            sample_rate = reader.getframerate()
            sample_count = reader.getnframes()
            channels = reader.getnchannels()
            width = reader.getsampwidth()
            if sample_rate <= 0 or sample_count <= 0 or channels <= 0:
                raise ValueError("WAV must have a positive rate, channel count and samples")
            if width not in (1, 2, 3, 4):
                raise ValueError("Only 8/16/24/32-bit integer PCM WAV is supported")
            validate_pcm_header(
                path, sample_rate=sample_rate, channels=channels,
                sample_width=width, sample_count=sample_count,
            )

            frame_count = _ceil_div(sample_count * fps, sample_rate)
            for index in range(frame_count):
                start = _ceil_div(index * sample_rate, fps)
                end = min(sample_count, _ceil_div((index + 1) * sample_rate, fps))
                expected = (end - start) * channels * width
                data = reader.readframes(end - start)
                if len(data) != expected:
                    raise ValueError("Truncated PCM WAV sample data")
                if expected:
                    normalized = _normalized_pcm(data, width)
                    rms = float(np.sqrt(np.mean(normalized * normalized)))
                else:
                    rms = 0.0
                levels.append((start, end, rms))
    except (wave.Error, EOFError) as exc:
        raise ValueError(f"Invalid/unsupported PCM WAV: {exc}") from exc
    except OSError as exc:
        raise ValueError(f"Unable to read WAV: {exc}") from exc

    states = gate_levels(
        (rms for _, _, rms in levels),
        open_threshold=open_threshold,
        close_threshold=close_threshold,
    )
    return VolumeSchedule(
        sample_rate=sample_rate,
        channels=channels,
        sample_width_bits=width * 8,
        sample_count=sample_count,
        fps=fps,
        open_threshold=open_threshold,
        close_threshold=close_threshold,
        frames=tuple(
            MouthFrame(i, start, end, rms, states[i])
            for i, (start, end, rms) in enumerate(levels)
        ),
    )


def write_schedule_json(schedule: VolumeSchedule, destination: Path) -> None:
    """Publish JSON atomically and without clobbering existing paths."""
    import json

    if destination.suffix.lower() != ".json":
        raise ValueError("Schedule output must end in .json")
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"Schedule already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=".tachie-mouth-", suffix=".json", dir=destination.parent
    )
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(
                schedule.as_dict(), output, ensure_ascii=False,
                indent=2, allow_nan=False,
            )
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        # Same-directory hardlink is an atomic no-overwrite publication.
        os.link(temp, destination)
    finally:
        temp.unlink(missing_ok=True)
