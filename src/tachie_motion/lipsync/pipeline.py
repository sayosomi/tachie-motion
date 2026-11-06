"""One-character WAV-driven mouth animation with atomic media publication."""

from dataclasses import dataclass
import os
from pathlib import Path
import stat
import tempfile

from tachie_motion.audio.volume import VolumeSchedule, analyze_wav
from tachie_motion.psd.mouth_variants import render_mouth_variants
from tachie_motion.render.probe import ProresReport
from tachie_motion.render.sequence import encode_prores_sequence
from tachie_motion.render.pcm_mux import mux_verified_pcm
from tachie_motion.timeline.media import MovieTiming, WaveTiming
from tachie_motion.timeline.otio_json import (
    build_rounded_utterance, write_otio,
)


def _rollback_published_mov(published: Path, owned_stage: Path) -> None:
    """Atomically quarantine the live pathname before checking ownership.

    No check-then-unlink of the public path: a concurrent writer's replacement
    is kept in a private recovery directory rather than removed.
    """
    recovery = Path(tempfile.mkdtemp(
        prefix=f".{published.stem}.failed-", dir=published.parent,
    ))
    candidate = recovery / "candidate.mov"
    try:
        os.rename(published, candidate)
    except OSError as exc:
        raise RuntimeError(
            f"MOV rollback incomplete; inspect {recovery} and {published}"
        ) from exc
    source = owned_stage.stat()
    captured = candidate.lstat()
    if (not stat.S_ISREG(captured.st_mode) or
        (source.st_dev, source.st_ino) != (captured.st_dev, captured.st_ino)):
        raise RuntimeError(
            f"Concurrent MOV replacement was preserved in {recovery};"
            " manual recovery required"
        )
    # Only remove the quarantined inode, never the public pathname.
    candidate.unlink()
    recovery.rmdir()


@dataclass(frozen=True, slots=True)
class MouthExportResult:
    schedule: VolumeSchedule
    video: ProresReport


def export_mouth_animation(
    *, psd: Path, wav: Path, closed_path: str, open_path: str,
    mov: Path, otio: Path, fps: int = 30,
    open_threshold: float = 0.05, close_threshold: float = 0.025,
    padding: int = 16, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe",
) -> MouthExportResult:
    """Export one PCM-in-MOV + OTIO, preserving sources and destinations.

    Both outputs are staged before final publication. If OTIO publication
    fails, quarantine the public MOV path before ownership verification.
    """
    if mov.suffix.lower() != ".mov" or otio.suffix.lower() != ".otio":
        raise ValueError("Output paths must have .mov and .otio extensions")
    # An interrupted or competing rollback must be inspected before reusing
    # the same public filename, even if the MOV pathname is now missing.
    if mov.parent.is_dir() and any(
        entry.name.startswith(f".{mov.stem}.failed-")
        for entry in mov.parent.iterdir()
    ):
        raise RuntimeError("Previous MOV export needs manual recovery")
    for destination in (mov, otio):
        if destination.exists() or destination.is_symlink():
            raise FileExistsError(f"Output already exists: {destination}")
    schedule = analyze_wav(
        wav, fps=fps, open_threshold=open_threshold,
        close_threshold=close_threshold,
    )
    mov.parent.mkdir(parents=True, exist_ok=True)
    otio.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".tachie-mouth-states-", dir=mov.parent,
    ) as frame_dir, tempfile.TemporaryDirectory(
        prefix=".tachie-mouth-otio-", dir=otio.parent,
    ) as otio_dir:
        stage_mov = Path(frame_dir) / "staged.mov"
        stage_otio = Path(otio_dir) / "staged.otio"
        closed_png, open_png = render_mouth_variants(
            psd, closed_path=closed_path, open_path=open_path,
            directory=Path(frame_dir), padding=padding,
        )
        indices = tuple(1 if frame.mouth == "open" else 0 for frame in schedule.frames)
        report = encode_prores_sequence(
            [closed_png, open_png], indices, stage_mov,
            fps=fps, ffmpeg=ffmpeg, ffprobe=ffprobe,
        )
        # The inspected output already confirms exact rate and frame count.
        if report.frames != len(indices) or report.decoded_frames != len(indices):
            raise RuntimeError("Inspected video did not match mouth schedule")
        pcm_mov = Path(frame_dir) / "pcm.mov"
        mux_verified_pcm(
            stage_mov, wav, pcm_mov,
            expected_samples=schedule.sample_count,
            expected_sample_rate=schedule.sample_rate,
            expected_channels=schedule.channels,
            expected_sample_width_bits=schedule.sample_width_bits,
            expected_pcm_sha256=schedule.pcm_sha256,
            ffmpeg=ffmpeg, ffprobe=ffprobe,
        )
        os.link(pcm_mov, mov)
        try:
            doc = build_rounded_utterance(
                mov, wav,
                MovieTiming(report.frames, fps),
                WaveTiming(schedule.sample_count, schedule.sample_rate),
                embedded_audio=True,
            )
            write_otio(doc, stage_otio)
            os.link(stage_otio, otio)
        except BaseException:
            # Race-safe even if another process replaces MOV during rollback.
            _rollback_published_mov(mov, pcm_mov)
            raise
    return MouthExportResult(schedule=schedule, video=report)
