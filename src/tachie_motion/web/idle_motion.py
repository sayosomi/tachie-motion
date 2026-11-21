"""Silent, scene-specific preset MOV rendering (no WAV or OTIO).

This is the backend building block for future idle-item editing.  It does not
implement loopable-library clips, project persistence, or a user-facing API.
"""

from collections.abc import Callable
from pathlib import Path
import tempfile

from tachie_motion.animation.blink import schedule_random_blink_frames
from tachie_motion.psd.crop import write_fixed_crop_png
from tachie_motion.render.sequence import encode_prores_sequence
from tachie_motion.web.eye_renderer import validate_closed_eye, render_blink_states
from tachie_motion.web.preset_preview import psd_snapshot_token
from tachie_motion.web.preset_utterance import validated_snapshot
from tachie_motion.web.solo_output import (
    initial_single_identity, publish_single, validate_media_basename,
)


# A temporary backend safety bound, not a product-level idle duration decision.
# The future UI must document/revisit its own duration limits before exposure.
MAX_IDLE_FRAMES = 216_000


def export_idle_motion(
    *, psd_path: Path, fingerprint: str, layers: list[dict],
    mov: Path, frame_count: int, fps: int = 30,
    blink_enabled: bool = False, eyes: dict | None = None,
    eye_groups: list[str] | None = None,
    blink_timing: dict | None = None,
    conflict_policy: str = "error",
    check_cancel: Callable[[], None] | None = None,
    on_progress: Callable[[str, int], None] | None = None,
) -> dict:
    """Render and exclusively publish a verified silent ProRes 4444 MOV.

    All frames are determined by the caller's integer frame count.  Only a
    fixed preset and the character's explicit closed-eye motion are supported.
    No source audio is opened or synthesized, and existing files are protected
    by the same single-MOV publisher as the utterance export.
    """
    def check() -> None:
        if check_cancel:
            check_cancel()

    def report(stage: str, percent: int) -> None:
        if on_progress:
            on_progress(stage, percent)

    if type(frame_count) is not int or not 1 <= frame_count <= MAX_IDLE_FRAMES:
        raise ValueError("Invalid idle frame count")
    if type(fps) is not int or fps not in (24, 30, 60):
        raise ValueError("Unsupported idle FPS")
    if type(blink_enabled) is not bool:
        raise ValueError("Blink setting must be a boolean")
    if (not mov.is_absolute() or ".." in mov.parts
            or mov.suffix.lower() != ".mov" or not mov.parent.is_dir()):
        raise ValueError("An existing output directory and MOV target are required")
    validate_media_basename(mov.stem)
    if blink_enabled and (
            type(blink_timing) is not dict or
            set(blink_timing) != {
                "interval_frames", "closed_frames", "jitter_frames",
                "phase_frames", "seed",
            }):
        raise ValueError("Blink requires explicit frame timing")

    check()
    prior = initial_single_identity(
        mov, conflict_policy, protect_otio_references=True,
    )
    check()
    psd, base = validated_snapshot(psd_path, fingerprint, layers)
    closed = (validate_closed_eye(psd, base, eyes, eye_groups)
              if blink_enabled else None)
    blink_frames = (schedule_random_blink_frames(
        frame_count=frame_count, **blink_timing,
    ) if closed is not None else (False,) * frame_count)
    indices = tuple(int(value) for value in blink_frames)

    report("待機用PSD画像を合成中", 10)
    work = tempfile.TemporaryDirectory(prefix=".tachie-idle-", dir=mov.parent)
    committed = False
    cleanup_warning = None
    try:
        directory = Path(work.name)
        if closed is not None:
            states = render_blink_states(psd, base, closed, ({},), directory)
        else:
            image = directory / "base.png"
            write_fixed_crop_png(psd, image, padding=16)
            states = [image]
        check()
        if psd_snapshot_token(str(psd_path)) != fingerprint:
            raise ValueError("PSD changed while preparing idle frames")
        staged = directory / "staged.mov"
        report("待機MOVをエンコード中", 25)
        encoded = encode_prores_sequence(
            states, indices, staged, fps=fps,
            check_cancel=check,
            on_verify=lambda: report("待機MOVの全フレームを検証中", 70),
        )
        if encoded.frames != frame_count or encoded.decoded_frames != frame_count:
            raise RuntimeError("Idle MOV frame count mismatch")
        check()
        if psd_snapshot_token(str(psd_path)) != fingerprint:
            raise ValueError("PSD changed during idle export")
        report("待機MOVを保存中", 90)
        check()
        if psd_snapshot_token(str(psd_path)) != fingerprint:
            raise ValueError("PSD changed immediately before publication")
        # No cancellation after publication begins.  Safe rollback is owned by
        # the publisher; an abort must not be mistaken for a completed cancel.
        warning = publish_single(
            staged, mov, policy=conflict_policy, prior=prior,
            protect_otio_references=True,
        )
        committed = True
    finally:
        try:
            work.cleanup()
        except OSError:
            if not committed:
                raise
            cleanup_warning = "Idle MOV saved; temporary files require inspection: " + work.name
    result = {"mov": str(mov), "frames": frame_count, "fps": fps, "audio": False}
    warnings = [value for value in (warning, cleanup_warning) if value]
    if warnings:
        result["warning"] = " ".join(warnings)
    try:
        report("待機MOVを保存しました", 100)
    except Exception as error:
        # Publication is already committed.  A failed progress observer must
        # not turn a successful export into a misleading failed/cancelled call.
        previous = result.get("warning", "")
        result["warning"] = (previous + " Progress observer failed: " +
                             str(error)).strip()
    return result
