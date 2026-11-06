"""Write synchronized OTIO using timing from a *newly verified* export.

This is a single-process workflow, not a persistent trust marker. Standalone
--mov media must continue to use timeline.media.probe_movie and -count_frames.
"""

from collections.abc import Sequence
from fractions import Fraction
from pathlib import Path

from tachie_motion.render.prores import encode_prores
from tachie_motion.timeline.media import MovieTiming, probe_wav
from tachie_motion.timeline.otio_json import build_single_utterance, write_otio


def export_verified_utterance(
    pngs: Sequence[Path],
    *,
    mov: Path,
    wav: Path,
    otio: Path,
    fps: int = 30,
    frames_per_state: int = 15,
    reuse_packets: bool = False,
):
    """Export MOV, fully validate its frames, then write 1-MOV/1-WAV OTIO.

    The exact video timing is obtained from the successful encode_prores report;
    it is *not* re-probed from an arbitrary path. No decoded-frame count gate is
    disabled. For an already-existing or externally supplied MOV, callers must
    use the standalone OTIO CLI, which retains its legacy decoding frame probe.

    A MOV may remain if a subsequent OTIO write fails. Existing outputs are
    never intentionally overwritten.
    """
    if frames_per_state <= 0 or len(pngs) < 2:
        raise ValueError("Expected at least two PNG states and a positive hold")
    if fps not in (24, 30, 60):
        raise ValueError("fps must be 24, 30 or 60")
    if mov.suffix.lower() != ".mov" or otio.suffix.lower() != ".otio":
        raise ValueError("Output extensions must be .mov and .otio")
    if mov.exists() or otio.exists():
        raise FileExistsError("MOV or OTIO output already exists")

    # Validate WAV and exact duration before incurring expensive encoding.
    audio_timing = probe_wav(wav)
    expected = MovieTiming(len(pngs) * frames_per_state, fps)
    if audio_timing.duration != expected.duration:
        raise ValueError(
            f"Duration mismatch: MOV={expected.duration}s,"
            f" WAV={audio_timing.duration}s"
        )

    # This function calls the real production encoder, which independently
    # decodes and verifies every output frame before returning its report.
    report = encode_prores(
        pngs, mov, fps=fps, frames_per_state=frames_per_state,
        reuse_packets=reuse_packets,
    )
    if (
        report.frames != expected.frames
        or report.decoded_frames != expected.frames
        or Fraction(report.fps) != fps
    ):
        raise RuntimeError("Verified MOV report contradicts requested timing")

    document = build_single_utterance(mov, wav, expected, audio_timing)
    write_otio(document, otio)
    return report
