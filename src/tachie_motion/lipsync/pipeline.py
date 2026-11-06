"""One-character WAV-driven mouth animation with atomic media publication."""

from dataclasses import dataclass
import os
from pathlib import Path
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
    fails, remove only the newly linked MOV owned by this operation.
    """
    if mov.suffix.lower() != ".mov" or otio.suffix.lower() != ".otio":
        raise ValueError("Output paths must have .mov and .otio extensions")
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
            # Never delete another writer's path on an unexpected race.
            try:
                original = pcm_mov.stat()
                published = mov.stat(follow_symlinks=False)
                if (original.st_dev, original.st_ino) == (
                    published.st_dev, published.st_ino
                ):
                    mov.unlink()
            except FileNotFoundError:
                pass
            raise
    return MouthExportResult(schedule=schedule, video=report)
