"""Strict, read-only sibling VOICEVOX/OpenJTalk LAB inspection.

LAB times are integer 100 ns ticks. This module validates source data; it
does not infer mouth shapes, quantize video frames, or enable aiueo output.
"""

from dataclasses import dataclass
import os
from pathlib import Path
import re
import stat
import wave

from tachie_motion.audio.wav_integrity import validate_pcm_header

TICKS_PER_SECOND = 10_000_000
MAX_LAB_BYTES = 2_000_000
MAX_INTERVALS = 50_000

# Explicitly supported Japanese OpenJTalk/VOICEVOX phone inventory.
# Unknown phones must not be silently mapped to a vowel.
SUPPORTED_PHONEMES = frozenset((
    "a i u e o A I U E O N pau sil silB silE br cl "
    "b by ch d dy f g gw gy h hy j k kw ky m my n ny "
    "p py r ry s sh t ts ty v w y z"
).split())
_TICK = re.compile(r"[0-9]{1,16}\Z")


@dataclass(frozen=True, slots=True)
class LabInterval:
    start_tick: int
    end_tick: int
    phoneme: str


@dataclass(frozen=True, slots=True)
class LabInspection:
    status: str  # "valid", "missing", "invalid"
    path: Path
    intervals: tuple[LabInterval, ...] = ()
    reason: str | None = None


def parse_lab(text: str, *, samples: int, sample_rate: int) -> tuple[LabInterval, ...]:
    """Parse integer-tick LAB, rejecting unknown phones and out-of-WAV time.

    Gaps are allowed; overlaps and zero-length intervals are not. WAV sample
    count is authoritative, with no floating-point time rounding tolerance.
    """
    if type(samples) is not int or type(sample_rate) is not int or samples <= 0 or sample_rate <= 0:
        raise ValueError("WAV timing must contain positive integer samples and sample rate")
    if not isinstance(text, str):
        raise ValueError("LAB must be text")
    lines = text.splitlines()
    if not lines or len(lines) > MAX_INTERVALS:
        raise ValueError("LAB has no intervals or too many intervals")
    result = []
    previous_end = 0
    for line_no, line in enumerate(lines, 1):
        fields = line.split()
        if len(fields) != 3:
            raise ValueError(f"LAB line {line_no}: expected start end phoneme")
        start_raw, end_raw, phoneme = fields
        if not _TICK.fullmatch(start_raw) or not _TICK.fullmatch(end_raw):
            raise ValueError(f"LAB line {line_no}: times must be integer 100ns ticks")
        start, end = int(start_raw), int(end_raw)
        if start >= end or start < previous_end:
            raise ValueError(f"LAB line {line_no}: nonpositive or overlapping interval")
        if end * sample_rate > samples * TICKS_PER_SECOND:
            raise ValueError(f"LAB line {line_no}: interval exceeds WAV samples")
        if phoneme not in SUPPORTED_PHONEMES:
            raise ValueError(f"LAB line {line_no}: unsupported phoneme")
        result.append(LabInterval(start, end, phoneme))
        previous_end = end
    return tuple(result)


def _identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return (info.st_dev, info.st_ino, info.st_ctime_ns, info.st_size, info.st_mtime_ns)


def _read_regular_lab(path: Path) -> str:
    """Open without following a final symlink; bound input and check replacement."""
    if path.is_symlink():
        raise ValueError("LAB symlinks are not supported")
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as stream:
        initial = os.fstat(stream.fileno())
        if not stat.S_ISREG(initial.st_mode) or _identity(os.lstat(path)) != _identity(initial):
            raise ValueError("LAB must be a stable regular file")
        raw = stream.read(MAX_LAB_BYTES + 1)
        if len(raw) > MAX_LAB_BYTES:
            raise ValueError("LAB exceeds size limit")
        if (_identity(os.fstat(stream.fileno())) != _identity(initial)
                or _identity(os.lstat(path)) != _identity(initial)):
            raise ValueError("LAB changed during inspection")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeError as exc:
        raise ValueError("LAB must be UTF-8") from exc


def inspect_adjacent_lab(
    wav_path: Path, *, expected_wav_identity: tuple[int, int, int, int, int] | None = None,
) -> LabInspection:
    """Inspect exact .lab sibling of a PCM WAV without changing either source.

    Existing callers can pass their registered WAV stat identity to reject
    source replacement. Invalid/missing results do not trigger mode fallback.
    """
    wav_path = Path(wav_path)
    lab_path = wav_path.with_suffix(".lab")
    try:
        if wav_path.suffix.lower() != ".wav" or wav_path.is_symlink():
            raise ValueError("Expected a regular WAV path")
        # O_NONBLOCK prevents an unwritten FIFO from hanging in open(); the
        # fd's mode is checked before wave parses any bytes.
        flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(wav_path, flags)
        with os.fdopen(descriptor, "rb") as stream:
            source = os.fstat(stream.fileno())
            before = _identity(source)
            if not stat.S_ISREG(source.st_mode) or _identity(os.lstat(wav_path)) != before:
                raise ValueError("WAV must be a stable regular file")
            if expected_wav_identity is not None and before != expected_wav_identity:
                raise ValueError("WAV changed since registration")
            # wave and the RIFF integrity scanner must read the same opened
            # inode, even if another process swaps the pathname meanwhile.
            with wave.open(stream, "rb") as reader:
                if reader.getcomptype() != "NONE":
                    raise ValueError("Only PCM WAV is supported")
                samples = reader.getnframes()
                rate = reader.getframerate()
                channels = reader.getnchannels()
                width = reader.getsampwidth()
                if samples <= 0 or rate <= 0 or channels <= 0 or width not in (1, 2, 3, 4):
                    raise ValueError("Invalid WAV PCM timing or format")
                validate_pcm_header(
                    wav_path, sample_rate=rate, channels=channels,
                    sample_width=width, sample_count=samples, stream=stream,
                )
            if (_identity(os.fstat(stream.fileno())) != before
                    or _identity(os.lstat(wav_path)) != before):
                raise ValueError("WAV changed during inspection")
            if lab_path.is_symlink():
                raise ValueError("LAB symlinks are not supported")
            if not lab_path.exists():
                result = LabInspection("missing", lab_path)
            else:
                intervals = parse_lab(_read_regular_lab(lab_path), samples=samples, sample_rate=rate)
                result = LabInspection("valid", lab_path, intervals)
            if (_identity(os.fstat(stream.fileno())) != before
                    or _identity(os.lstat(wav_path)) != before):
                raise ValueError("WAV changed during LAB inspection")
            return result
    except (OSError, ValueError, wave.Error, EOFError) as exc:
        return LabInspection("invalid", lab_path, reason=str(exc))
