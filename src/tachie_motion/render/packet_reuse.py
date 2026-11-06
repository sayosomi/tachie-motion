"""Opt-in intra-frame ProRes packet reuse; never replaces decoded validation.

This module only creates an intermediate MOV. The caller must still run
inspect_prores() against *every* decoded frame before publishing the output.
"""

from fractions import Fraction
import json
import re
from pathlib import Path
import subprocess
import tempfile


class ReuseUnavailable(RuntimeError):
    """Optional optimization unsupported; caller may encode normally."""


def _capture(args: list[str], *, data: bytes | None = None) -> bytes:
    try:
        proc = subprocess.run(
            args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as exc:
        raise ReuseUnavailable(f"Could not start reuse tool: {exc}") from exc
    if proc.returncode:
        message = proc.stderr.decode("utf-8", "replace")[-1000:]
        raise ReuseUnavailable(f"Packet reuse tool failed: {message}")
    return proc.stdout


def _inspect(
    video: Path, *, ffprobe: str,
) -> tuple[dict, list[dict]]:
    raw = _capture([
        ffprobe, "-v", "error", "-select_streams", "v:0",
        "-show_packets", "-show_data_hash", "sha256",
        "-show_entries",
        "stream=codec_name,profile,pix_fmt,width,height,nb_frames,"
        "avg_frame_rate,r_frame_rate,time_base,duration:"
        "packet=pts,dts,duration,flags,data_hash",
        "-of", "json", str(video),
    ])
    try:
        data = json.loads(raw)
        return data["streams"][0], data["packets"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise ReuseUnavailable(f"Incomplete packet metadata: {exc}") from exc


def _validate(
    stream: dict,
    packets: list[dict],
    *, dimensions: tuple[int, int], fps: int, frames: int,
    final: bool,
) -> list[str]:
    try:
        if (
            stream["codec_name"] != "prores"
            or "4444" not in stream["profile"]
            or not stream["pix_fmt"].startswith("yuva444p")
            or (int(stream["width"]), int(stream["height"])) != dimensions
            or Fraction(stream["r_frame_rate"]) != fps
            or Fraction(stream["avg_frame_rate"]) != fps
            or int(stream["nb_frames"]) != frames
            or len(packets) != frames
        ):
            raise ValueError("Stream profile, dimensions, fps or count differs")
        # ffprobe prints stream duration as a rounded decimal (e.g. 8/24
        # becomes "0.333333"). Exact per-packet PTS/DTS/duration below is
        # authoritative; this loose metadata check catches gross mismatch.
        if final and abs(
            Fraction(stream["duration"]) - Fraction(frames, fps)
        ) > Fraction(1, 1000000):
            raise ValueError("Output MOV duration differs")
        tick = Fraction(1, fps) / Fraction(stream["time_base"])
        if tick.denominator != 1 or tick.numerator < 1:
            raise ValueError("Noninteger ProRes frame duration")
        hashes = []
        for index, pkt in enumerate(packets):
            if (
                int(pkt["pts"]) != index * tick.numerator
                or int(pkt["dts"]) != index * tick.numerator
                or int(pkt["duration"]) != tick.numerator
                or pkt["flags"] not in ("K_", "K__")
            ):
                raise ValueError(f"Packet {index} has irregular timing or flags")
            digest = pkt["data_hash"]
            if not isinstance(digest, str) or re.fullmatch(r"SHA256:[0-9a-fA-F]{64}", digest) is None:
                raise ValueError("Malformed packet SHA256 digest")
            hashes.append(digest)
        return hashes
    except (KeyError, IndexError, TypeError, ValueError, ZeroDivisionError, AttributeError) as exc:
        if final:
            raise RuntimeError(f"Unsafe reused ProRes packet output: {exc}") from exc
        raise ReuseUnavailable(f"Single-frame ProRes incompatible: {exc}") from exc


def encode_reused(
    images: list[bytes],
    dimensions: tuple[int, int],
    *, fps: int, hold: int, destination: Path,
    ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe",
) -> None:
    """Encode each state once, stream-copy exact-timed repeated key packets.

    Preconditions are conservative. Only per-state repeated holds and at most
    8 distinct states are supported; other inputs should take the old encoder.
    All paths within the concat manifest are generated ASCII basenames.
    """
    if fps not in (24, 30, 60) or hold < 2 or len(images) < 2 or len(images) > 8:
        raise ReuseUnavailable("Unprofitable or unsupported repeated states")
    if any(len(frame) != dimensions[0] * dimensions[1] * 4 for frame in images):
        raise ValueError("Malformed source RGBA state size")

    from tachie_motion.render.prores import ffmpeg_args

    # One staging directory per invocation: no races over intermediate names.
    # Intermediate MOVs are automatically removed on any failure.
    with tempfile.TemporaryDirectory(
        prefix=".tachie-packet-reuse-", dir=destination.parent
    ) as folder:
        staging = Path(folder)
        singles: list[Path] = []
        expected_hashes: list[str] = []
        timebase: Fraction | None = None
        tick = 0
        for i, frame in enumerate(images):
            single = staging / f"single_{i:03}.mov"
            _capture(ffmpeg_args(
                ffmpeg=ffmpeg, dimensions=dimensions, fps=fps,
                frame_count=1, output=single,
            ), data=frame)
            stream, packets = _inspect(single, ffprobe=ffprobe)
            digest = _validate(
                stream, packets, dimensions=dimensions, fps=fps,
                frames=1, final=False,
            )[0]
            base = Fraction(stream["time_base"])
            if timebase is None:
                timebase = base
                step = Fraction(1, fps) / base
                if step.denominator != 1 or step.numerator < 1:
                    raise ReuseUnavailable("Unsupported ProRes time base")
                tick = step.numerator
            elif base != timebase:
                raise ReuseUnavailable("ProRes singles have different time bases")
            singles.append(single)
            expected_hashes.extend([digest] * hold)

        rewrite = f"setts=pts=N*{tick}:dts=N*{tick}:duration={tick}"
        segments: list[Path] = []
        for i, single in enumerate(singles):
            segment = staging / f"hold_{i:03}.mov"
            _capture([
                ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
                "-stream_loop", str(hold - 1), "-i", str(single),
                "-map", "0:v:0", "-an", "-c:v", "copy", "-bsf:v",
                rewrite, "-f", "mov", "-y", str(segment),
            ])
            segments.append(segment)

        manifest = staging / "parts.ffconcat"
        manifest.write_text(
            "ffconcat version 1.0\n"
            + "".join(f"file '{segment.name}'\n" for segment in segments),
            encoding="ascii",
        )
        _capture([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "concat", "-safe", "1", "-i", str(manifest),
            "-map", "0:v:0", "-an", "-c:v", "copy", "-bsf:v",
            rewrite, "-f", "mov", "-y", str(destination),
        ])
        stream, packets = _inspect(destination, ffprobe=ffprobe)
        actual_hashes = _validate(
            stream, packets, dimensions=dimensions, fps=fps,
            frames=len(images) * hold, final=True,
        )
        if actual_hashes != expected_hashes:
            raise RuntimeError("Unsafe reused ProRes payload mismatch")
