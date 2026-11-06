"""Mux source WAV integer PCM into a previously verified silent ProRes MOV.

No video re-encode, AAC conversion, WAV edits, or implicit audio padding.
Only completed and independently verified mux outputs may be published.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import wave

from tachie_motion.audio.wav_integrity import validate_pcm_header

_AUDIO_CODECS = {1: "pcm_s8", 2: "pcm_s16le", 3: "pcm_s24le", 4: "pcm_s32le"}
_AUDIO_FORMATS = {1: "s8", 2: "s16le", 3: "s24le", 4: "s32le"}


def _command(args: list[str]) -> bytes:
    try:
        proc = subprocess.run(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
    except OSError as exc:
        raise RuntimeError(f"Could not run media tool: {exc}") from exc
    if proc.returncode:
        raise RuntimeError("Media tool failed: " + proc.stderr.decode(
            "utf-8", "replace")[-1600:])
    return proc.stdout


def _streams(path: Path, ffprobe: str) -> list[dict]:
    data = _command([ffprobe, "-v", "error", "-show_streams", "-of", "json",
                     str(path)])
    return json.loads(data)["streams"]


def _video_packets(path: Path, ffprobe: str) -> list[tuple[str, int, int, int]]:
    """Compare every packet's bytes AND exact decode/presentation timeline."""
    data = _command([
        ffprobe, "-v", "error", "-select_streams", "v:0",
        "-show_packets", "-show_data_hash", "sha256",
        "-show_entries", "packet=data_hash,pts,dts,duration",
        "-of", "json", str(path),
    ])
    packets = json.loads(data)["packets"]
    try:
        return [
            (packet["data_hash"], int(packet["pts"]), int(packet["dts"]),
             int(packet["duration"]))
            for packet in packets
        ]
    except (KeyError, ValueError, TypeError) as exc:
        raise ValueError("Missing or invalid video packet timing") from exc


def _source_pcm_digest(wav: Path, width: int) -> tuple[int, str, str]:
    """Return decoded-MOV identity and original raw-WAV PCM digest."""
    decoded_digest = hashlib.sha256()
    source_digest = hashlib.sha256()
    total = 0
    with wave.open(str(wav), "rb") as source:
        while chunk := source.readframes(16384):
            source_digest.update(chunk)
            if width == 1:
                # WAV 8-bit PCM is unsigned; MOV pcm_s8 uses signed samples.
                chunk = bytes(value ^ 0x80 for value in chunk)
            total += len(chunk)
            decoded_digest.update(chunk)
    return total, decoded_digest.hexdigest(), source_digest.hexdigest()


def _decoded_pcm_digest(mov: Path, width: int, ffmpeg: str) -> tuple[int, str]:
    args = [
        ffmpeg, "-v", "error", "-nostdin", "-i", str(mov),
        "-map", "0:a:0", "-vn", "-c:a", _AUDIO_CODECS[width],
        "-f", _AUDIO_FORMATS[width], "pipe:1",
    ]
    try:
        proc = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise RuntimeError(f"Could not run FFmpeg: {exc}") from exc
    digest = hashlib.sha256()
    size = 0
    try:
        assert proc.stdout is not None
        while data := proc.stdout.read(1024 * 1024):
            size += len(data)
            digest.update(data)
        errors = proc.stderr.read() if proc.stderr else b""
        code = proc.wait()
    except BaseException:
        proc.kill()
        proc.communicate()
        raise
    finally:
        if proc.stdout:
            proc.stdout.close()
        if proc.stderr:
            proc.stderr.close()
    if code:
        raise RuntimeError("Decoded PCM verification failed: " + errors.decode(
            "utf-8", "replace")[-1600:])
    return size, digest.hexdigest()


def mux_verified_pcm(
    silent_mov: Path, wav: Path, output: Path, *,
    expected_samples: int, expected_sample_rate: int,
    expected_channels: int | None = None,
    expected_sample_width_bits: int | None = None,
    expected_pcm_sha256: str | None = None,
    ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe",
) -> None:
    """Publish a MOV only if audio samples and video packet bytes are identical.

    PCM formats: integer 8/16/24/32-bit mono/stereo RIFF PCM. WAV 8-bit
    unsigned samples are carried as equivalent signed 8-bit MOV PCM.
    Output must be a new file; the caller owns pair-wide publication/rollback.
    """
    if output.suffix.lower() != ".mov" or silent_mov.suffix.lower() != ".mov":
        raise ValueError("PCM mux input/output must be MOV files")
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"MOV already exists: {output}")
    if not silent_mov.is_file() or not wav.is_file():
        raise ValueError("Existing silent MOV and PCM WAV are required")
    try:
        with wave.open(str(wav), "rb") as source:
            if source.getcomptype() != "NONE":
                raise ValueError("Only uncompressed integer PCM WAV is supported")
            channels, width = source.getnchannels(), source.getsampwidth()
            samples, rate = source.getnframes(), source.getframerate()
    except (OSError, wave.Error) as exc:
        raise ValueError(f"Invalid PCM WAV: {exc}") from exc
    if channels not in (1, 2) or width not in _AUDIO_CODECS:
        raise ValueError("Only mono/stereo 8/16/24/32-bit integer PCM WAV is supported")
    if (expected_channels is not None and channels != expected_channels) or (
        expected_sample_width_bits is not None
        and width * 8 != expected_sample_width_bits
    ):
        raise ValueError("WAV PCM format changed after animation analysis")
    if samples <= 0 or rate <= 0 or (samples, rate) != (expected_samples, expected_sample_rate):
        raise ValueError("Source WAV timing differs from the animation schedule")
    validate_pcm_header(
        wav, sample_rate=rate, channels=channels, sample_width=width,
        sample_count=samples,
    )
    source_stat = wav.stat()
    expected_data = _source_pcm_digest(wav, width)
    if expected_pcm_sha256 is not None and expected_data[2] != expected_pcm_sha256:
        raise ValueError("WAV PCM changed after animation analysis")
    video_before = _streams(silent_mov, ffprobe)
    if len(video_before) != 1 or video_before[0]["codec_name"] != "prores":
        raise ValueError("Expected one silent ProRes video stream")
    packet_hashes = _video_packets(silent_mov, ffprobe)
    if not packet_hashes:
        raise ValueError("Silent MOV has no video packets")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(
        prefix=".tachie-pcm-", suffix=".mov", dir=output.parent,
    )
    os.close(fd)
    stage = Path(name)
    try:
        _command([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
            "-i", str(silent_mov), "-i", str(wav),
            "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
            "-c:a", _AUDIO_CODECS[width], "-map_metadata", "-1",
            "-map_chapters", "-1", "-f", "mov", "-y", str(stage),
        ])
        streams = _streams(stage, ffprobe)
        if len(streams) != 2:
            raise RuntimeError("Mux output must contain exactly one video and one audio stream")
        video, audio = streams
        if video["codec_type"] != "video" or audio["codec_type"] != "audio":
            raise RuntimeError("Mux stream order or type is unexpected")
        # Packet bytes alone do not prove that mux preserved frame timing.
        video_fields = (
            "codec_name", "profile", "pix_fmt", "time_base",
            "start_pts", "duration_ts", "avg_frame_rate", "r_frame_rate",
        )
        if (
            tuple(video.get(key) for key in video_fields)
            != tuple(video_before[0].get(key) for key in video_fields)
            or packet_hashes != _video_packets(stage, ffprobe)
        ):
            raise RuntimeError("Mux changed ProRes packets or video timing")
        if (
            audio["codec_name"], int(audio["sample_rate"]), int(audio["channels"]),
        ) != (_AUDIO_CODECS[width], rate, channels):
            raise RuntimeError("Mux PCM codec, sample rate or channels differ")
        if int(audio.get("start_pts", -1)) != 0 or int(audio.get("duration_ts", -1)) != samples:
            raise RuntimeError("Mux shifted, padded or shortened audio timing")
        if _decoded_pcm_digest(stage, width, ffmpeg) != expected_data[:2]:
            raise RuntimeError("Mux lost, duplicated or modified PCM samples")
        if expected_pcm_sha256 is not None and (
            _source_pcm_digest(wav, width)[2] != expected_pcm_sha256
        ):
            raise ValueError("WAV PCM changed during mux")
        after = wav.stat()
        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
            source_stat.st_dev, source_stat.st_ino,
            source_stat.st_size, source_stat.st_mtime_ns,
        ):
            raise ValueError("Source WAV changed during mux")
        os.link(stage, output)  # No-clobber publication, including symlinks.
    finally:
        stage.unlink(missing_ok=True)
