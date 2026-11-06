"""Strict RIFF PCM header checks not provided by Python's wave module.

wave.getnframes() divides the data chunk size by the sample-frame size and
silently ignores a partial trailing sample frame. Validate the declared
structure before using wave for the actual audio samples.
"""

from pathlib import Path
import struct


def validate_pcm_header(
    path: Path, *, sample_rate: int, channels: int,
    sample_width: int, sample_count: int,
) -> None:
    """Validate fmt byte alignment/rate and complete declared PCM data frames.

    Scan RIFF chunk headers without buffering the audio data. Honor unknown
    pre-data chunks and word-alignment padding. A final odd-sized data chunk
    need not have a trailing pad byte (as emitted by Python's wave writer).
    """
    with path.open("rb") as stream:
        stream.seek(0, 2)
        file_size = stream.tell()
        stream.seek(0)
        header = stream.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE":
            raise ValueError("Invalid RIFF/WAVE header")
        riff_end = 8 + struct.unpack_from("<I", header, 4)[0]
        if riff_end < 12 or riff_end > file_size:
            raise ValueError("Truncated or invalid RIFF/WAVE chunk")

        offset = 12
        fmt_seen = False
        while offset + 8 <= riff_end:
            stream.seek(offset)
            chunk = stream.read(8)
            kind, size = struct.unpack("<4sI", chunk)
            data_start = offset + 8
            data_end = data_start + size
            if data_end > riff_end:
                raise ValueError("Truncated WAV chunk")

            if kind == b"fmt " and not fmt_seen:
                if size < 16:
                    raise ValueError("Invalid PCM fmt chunk")
                stream.seek(data_start)
                fmt_data = stream.read(16)
                fmt_tag, fmt_channels, fmt_rate, byte_rate, align, bits = (
                    struct.unpack("<HHIIHH", fmt_data)
                )
                # The wave reader still decides whether the format tag and
                # any extensible-format subtype are supported.
                expected_align = channels * sample_width
                if (
                    fmt_channels != channels
                    or fmt_rate != sample_rate
                    or bits != sample_width * 8
                    or align != expected_align
                    or byte_rate != sample_rate * expected_align
                ):
                    raise ValueError("Inconsistent PCM fmt block_align or byte_rate")
                fmt_seen = True
            elif kind == b"data":
                if not fmt_seen:
                    raise ValueError("PCM data chunk precedes fmt chunk")
                frame_bytes = channels * sample_width
                if size % frame_bytes:
                    raise ValueError("Incomplete PCM sample frame in data chunk")
                if size // frame_bytes != sample_count:
                    raise ValueError("WAV sample count disagrees with PCM data chunk")
                return

            # RIFF chunks are word-aligned. Missing padding in a nonfinal
            # pre-data chunk is not a valid way to encode the next header.
            offset = data_end + (size & 1)

    raise ValueError("Missing PCM fmt or data chunk")
