"""Local HTTP adapter for silent scene-specific MOV exports.

The user-facing idle item editor and project persistence are separate slices.
This router uses the existing single-export progress and cancellation contract.
"""

import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, StrictBool, StrictInt

from tachie_motion.animation.blink import schedule_blink_frames
from tachie_motion.web.eye_renderer import validate_closed_eye
from tachie_motion.web.export_progress import ExportCancelled
from tachie_motion.web.idle_motion import MAX_IDLE_FRAMES, export_idle_motion
from tachie_motion.web.preset_preview import psd_snapshot_token
from tachie_motion.web.preset_utterance import validated_snapshot
from tachie_motion.web.preview_frame import file_identity
from tachie_motion.web.service import local_file
from tachie_motion.web.solo_output import validate_media_basename


router = APIRouter()


class IdleMotionExportRequest(BaseModel):
    psd: str
    fingerprint: str
    source_identity: str
    layers: list[dict]
    frame_count: StrictInt
    fps: StrictInt = 30
    blink_enabled: StrictBool = False
    eyes: dict | None = None
    eye_groups: list[str] | None = None
    blink_timing: dict | None = None
    output_dir: str
    basename: str
    conflict_policy: str = "error"
    progress_id: str | None = None


def validate_idle_preflight(payload: IdleMotionExportRequest, source: Path) -> None:
    """Reject invalid registration/pose data before invoking the renderer.

    This is an early HTTP admission check, not the renderer's source-safety
    boundary. The renderer independently checks the PSD again before publish.
    """
    identity = file_identity(source)
    if ":".join(map(str, identity)) != payload.source_identity:
        raise ValueError("PSD identity changed since preset registration")
    if psd_snapshot_token(str(source)) != payload.fingerprint:
        raise ValueError("PSD changed since preset registration")

    if payload.blink_enabled:
        timing = payload.blink_timing
        if type(timing) is not dict or set(timing) != {
                "interval_frames", "closed_frames", "jitter_frames",
                "phase_frames", "seed",
        }:
            raise ValueError("Blink requires explicit frame timing")
        # Validate the scheduler's exact integer and interval rules without
        # allocating a video-length frame sequence or drawing random values.
        schedule_blink_frames(frame_count=0, **timing)

    psd, base = validated_snapshot(source, payload.fingerprint, payload.layers)
    if payload.blink_enabled:
        validate_closed_eye(psd, base, payload.eyes, payload.eye_groups)
    if file_identity(source) != identity:
        raise ValueError("PSD changed during idle request validation")


@router.post("/api/idle-motion-export")
async def idle_motion_export(payload: IdleMotionExportRequest, request: Request):
    """Render an idle MOV without WAV/PCM/OTIO or project JSON writes."""
    state = request.app.state
    try:
        if payload.fps not in (24, 30, 60):
            raise ValueError("FPS must be 24, 30 or 60")
        if not 1 <= payload.frame_count <= MAX_IDLE_FRAMES:
            raise ValueError("Invalid idle frame count")
        if payload.conflict_policy not in ("error", "overwrite"):
            raise ValueError("Unsupported output conflict policy")
        validate_media_basename(payload.basename)
        source = local_file(payload.psd, ".psd")
        folder = Path(payload.output_dir).expanduser()
        if not folder.is_absolute() or not folder.is_dir():
            raise ValueError("Output folder must already exist")
        folder = folder.resolve(strict=True)
        async with state.export_lock:
            state.batch.require_idle()
            token = payload.progress_id
            if token:
                state.export_progress.start(token, "single")

            def check_cancel() -> None:
                if token:
                    state.export_progress.check(token)

            def report(stage: str, percent: int) -> None:
                if not token or percent == 100:
                    return  # 100% only after the route confirms success.
                if percent >= 90:
                    # Publication must complete or recover without interruption.
                    state.export_progress.finalizing(token, stage)
                else:
                    state.export_progress.update(token, stage, percent)

            try:
                check_cancel()

                def validated_export():
                    # Keep PSD parsing off the API event loop. No renderer
                    # invocation occurs unless the entire preflight passes.
                    validate_idle_preflight(payload, source)
                    check_cancel()
                    return export_idle_motion(
                        psd_path=source,
                        fingerprint=payload.fingerprint,
                        source_identity=payload.source_identity,
                        layers=payload.layers,
                        mov=folder / (payload.basename + ".mov"),
                        frame_count=payload.frame_count,
                        fps=payload.fps,
                        blink_enabled=payload.blink_enabled,
                        eyes=payload.eyes,
                        eye_groups=payload.eye_groups,
                        blink_timing=payload.blink_timing,
                        conflict_policy=payload.conflict_policy,
                        check_cancel=check_cancel if token else None,
                        on_progress=report if token else None,
                    )

                worker = asyncio.create_task(asyncio.to_thread(
                    validated_export,
                ))
                while True:
                    try:
                        # A lost HTTP connection must not release the file
                        # publication lock while the worker still runs.
                        result = await asyncio.shield(worker)
                        break
                    except asyncio.CancelledError:
                        if worker.done():
                            result = worker.result()
                            break
                        continue
            except ExportCancelled:
                if token:
                    state.export_progress.finish(token, "cancelled")
                raise
            except Exception:
                if token:
                    state.export_progress.finish(token, "failed")
                raise
            except BaseException:
                if token:
                    state.export_progress.finish(token, "failed")
                raise
            if token:
                state.export_progress.finish(token, "success")
            return result
    except ExportCancelled as exc:
        raise HTTPException(409, str(exc)) from exc
    except (ValueError, FileExistsError, OSError, RuntimeError, TypeError) as exc:
        if payload.progress_id:
            state.export_progress.fail_reservation(payload.progress_id)
        raise HTTPException(400, str(exc)) from exc
