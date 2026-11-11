"""FastAPI endpoints for the first single-character local web screen."""

import asyncio
from pathlib import Path
import re
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware

from tachie_motion.lipsync.pipeline import export_mouth_animation
from tachie_motion.web.origin import configured_tailscale_origin
from tachie_motion.web.browser_preview_assets import layer_preview_assets, preview_source_status
from tachie_motion.web.preset_preview import preview_base_preset
from tachie_motion.web.preset_utterance import export_preset_utterance
from tachie_motion.web.output_destinations import destination_info, validate_basename
from tachie_motion.web.solo_output import validate_media_basename, single_destination
from tachie_motion.web.combined_otio import create_combined_otio
from tachie_motion.web.batch_session import BatchCoordinator, validate_names
from tachie_motion.web.service import (
    describe_psd, describe_wav, load_psd, local_file, preview_mouth,
)


class FileRequest(BaseModel):
    path: str


class BrowserLayersRequest(BaseModel):
    path: str
    fingerprint: str


class PreviewSourceStatusRequest(BrowserLayersRequest):
    source_identity: str


class PreviewRequest(BaseModel):
    path: str
    closed: str
    opened: str
    state: str


class PresetPreviewRequest(BaseModel):
    path: str
    fingerprint: str
    layers: list[dict]
    source_identity: str | None = None


class ExportRequest(BaseModel):
    psd: str
    wav: str
    closed: str
    opened: str
    output_dir: str
    basename: str
    fps: int = 30


class DestinationRequest(BaseModel):
    output_dir: str
    basename: str


class PresetUtteranceRequest(BaseModel):
    psd: str
    wav: str
    fingerprint: str
    layers: list[dict]
    mouth: dict | None = None
    mode: str
    blink_enabled: bool = False
    conflict_policy: str = "error"
    output_dir: str
    basename: str
    fps: int = 30
    source_identity: str



class BatchNameRequest(BaseModel):
    basenames: list[str]
    timeline_basename: str


class BatchPlannedMedia(BaseModel):
    basename: str
    wav: str
    source_identity: str
    fps: int
    samples: int
    sample_rate: int
    conflict_policy: str


class BatchStartRequest(BaseModel):
    output_dir: str
    timeline_basename: str
    timeline_policy: str
    entries: list[BatchPlannedMedia]


class BatchIdentifier(BaseModel):
    batch_id: str


class BatchMovRequest(PresetUtteranceRequest):
    batch_id: str
    batch_index: int


class CombinedMedia(BaseModel):
    basename: str
    frames: int
    fps: int
    samples: int
    sample_rate: int


class CombinedOtioRequest(DestinationRequest):
    entries: list[CombinedMedia]
    batch_id: str
    conflict_policy: str = "error"


app = FastAPI(title="tachie-motion local web", docs_url=None, redoc_url=None)
TAILSCALE_ORIGIN = configured_tailscale_origin()
allowed_hosts = ["127.0.0.1", "localhost"]
if TAILSCALE_ORIGIN is not None:
    allowed_hosts.append(urlsplit(TAILSCALE_ORIGIN).hostname)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
app.state.export_lock = asyncio.Lock()
app.state.batch = BatchCoordinator()
FRONTEND_DIST = Path(__file__).resolve().parents[3] / "frontend" / "dist"
if (FRONTEND_DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


@app.middleware("http")
async def restrict_origins(request: Request, call_next):
    # Starlette's TrustedHostMiddleware checks hostnames but not port numbers.
    # Refuse a wrong external port even when its tailnet hostname is allowed.
    if TAILSCALE_ORIGIN is not None:
        tailnet_host = urlsplit(TAILSCALE_ORIGIN).hostname
        received_host = request.headers.get("host", "").lower()
        if received_host == tailnet_host or (
            received_host.startswith(tailnet_host + ":")
            and received_host != tailnet_host + ":8443"
        ):
            return JSONResponse({"detail": "Untrusted tailnet host port"}, status_code=400)
    if request.method not in ("GET", "HEAD", "POST"):
        return JSONResponse({"detail": "Method not allowed"}, status_code=405)
    if request.method == "POST":
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            return JSONResponse({"detail": "JSON required"}, status_code=415)
        origin = request.headers.get("origin")
        if origin is not None:
            try:
                value = urlsplit(origin)
                accepted = (
                    value.scheme == request.url.scheme
                    and value.hostname == request.url.hostname
                    and (value.port or 80) == (request.url.port or 80)
                    and value.username is None
                    and value.password is None
                    and value.path in ("", "/")
                    and not value.query
                    and not value.fragment
                )
            except ValueError:
                accepted = False
            # Opt-in tailnet access still requires an exact Origin match.
            # Do not trust arbitrary X-Forwarded-* headers supplied by clients.
            if not accepted and origin == TAILSCALE_ORIGIN:
                accepted = True
            if not accepted:
                return JSONResponse({"detail": "Cross-origin requests forbidden"}, status_code=403)
    return await call_next(request)


def bad_request(exc: Exception):
    return HTTPException(status_code=400, detail=str(exc))


@app.get("/api/health")
def health():
    return {"ok": True, "default_output_dir": str(Path.home() / "Movies")}


@app.post("/api/psd")
def psd_info(payload: FileRequest):
    try:
        return describe_psd(payload.path)
    except (ValueError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preview-source-status")
def source_status(payload: PreviewSourceStatusRequest):
    try:
        return preview_source_status(payload.path, payload.fingerprint, payload.source_identity)
    except (ValueError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preview-layer-assets")
def preview_layer_assets(payload: BrowserLayersRequest):
    try:
        return layer_preview_assets(payload.path, payload.fingerprint)
    except (ValueError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preview")
def mouth_preview(payload: PreviewRequest):
    try:
        return preview_mouth(payload.path, payload.closed, payload.opened, payload.state)
    except (ValueError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preset-preview")
def preset_preview(payload: PresetPreviewRequest):
    try:
        return preview_base_preset(
            payload.path, payload.fingerprint, payload.layers,
            source_identity=payload.source_identity,
        )
    except (ValueError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/wav")
def wav_info(payload: FileRequest):
    try:
        return describe_wav(payload.path)
    except (ValueError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/wav-playback")
def wav_playback(payload: FileRequest):
    """Serve only an explicitly requested bounded local WAV for browser listening.

    JSON POST keeps arbitrary file paths out of URL history and uses the
    existing same-origin request guard. Source media is never modified.
    """
    try:
        wav = local_file(payload.path, ".wav")
        size = wav.stat().st_size
        if not 0 < size <= 128 * 1024 * 1024:
            raise ValueError("WAV playback requires a file between 1 byte and 128 MiB")
        describe_wav(str(wav))  # Refuse a non-WAV file merely renamed with .wav.
        return FileResponse(
            wav, media_type="audio/wav",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )
    except (ValueError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preset-utterance-destination")
def preset_utterance_destination(payload: DestinationRequest):
    try:
        validate_basename(payload.basename)
        folder = Path(payload.output_dir).expanduser()
        if not folder.is_absolute() or not folder.is_dir():
            raise ValueError("Output folder must already exist")
        canonical = folder.resolve(strict=True)
        return {
            **destination_info(canonical, payload.basename),
            "canonical_output_dir": str(canonical),
        }
    except (ValueError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preset-utterance-export")
async def preset_utterance_export(payload: PresetUtteranceRequest):
    if payload.fps not in (24, 30, 60):
        raise HTTPException(400, "FPS must be 24, 30 or 60")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", payload.basename, re.ASCII):
        raise HTTPException(400, "Output basename must use 1-64 ASCII letters, digits, - or _")
    if payload.conflict_policy not in ("error", "overwrite"):
        raise HTTPException(400, "Unsupported output conflict policy")
    folder = Path(payload.output_dir).expanduser()
    if not folder.is_absolute() or not folder.is_dir():
        raise HTTPException(400, "Output folder must already exist")
    try:
        psd = local_file(payload.psd, ".psd")
        wav = local_file(payload.wav, ".wav")
        folder = folder.resolve(strict=True)
        async with app.state.export_lock:
            app.state.batch.require_idle()
            return await asyncio.to_thread(
                export_preset_utterance,
                psd_path=psd, wav=wav, fingerprint=payload.fingerprint,
                layers=payload.layers, mouth=payload.mouth, mode=payload.mode,
                blink_enabled=payload.blink_enabled, conflict_policy=payload.conflict_policy,
                mov=folder / (payload.basename + ".mov"),
                otio=folder / (payload.basename + ".otio"),
                fps=payload.fps, source_identity=payload.source_identity,
            )
    except (ValueError, FileExistsError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preset-batch-check-names")
def preset_batch_check_names(payload: BatchNameRequest):
    try:
        validate_names(payload.basenames, payload.timeline_basename)
        return {"valid": True}
    except (ValueError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preset-batch-start")
async def preset_batch_start(payload: BatchStartRequest):
    try:
        folder = Path(payload.output_dir).expanduser()
        if not folder.is_absolute() or not folder.is_dir():
            raise ValueError("Output folder must already exist")
        async with app.state.export_lock:
            token = await asyncio.to_thread(
                app.state.batch.start, folder, payload.timeline_basename,
                payload.timeline_policy, [entry.model_dump() for entry in payload.entries])
            return {"batch_id": token}
    except (ValueError, FileExistsError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preset-batch-cancel")
async def preset_batch_cancel(payload: BatchIdentifier):
    async with app.state.export_lock:
        return {"released": app.state.batch.release(payload.batch_id)}


@app.post("/api/preset-batch-mov-destination")
def preset_batch_mov_destination(payload: DestinationRequest):
    try:
        validate_media_basename(payload.basename)
        folder = Path(payload.output_dir).expanduser()
        if not folder.is_absolute() or not folder.is_dir():
            raise ValueError("Output folder must already exist")
        canonical = folder.resolve(strict=True)
        return {**single_destination(canonical / (payload.basename + ".mov")),
                "canonical_output_dir": str(canonical)}
    except (ValueError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preset-combined-otio-destination")
def preset_combined_otio_destination(payload: DestinationRequest):
    try:
        validate_media_basename(payload.basename)
        folder = Path(payload.output_dir).expanduser()
        if not folder.is_absolute() or not folder.is_dir():
            raise ValueError("Output folder must already exist")
        canonical = folder.resolve(strict=True)
        return {**single_destination(canonical / (payload.basename + ".otio")),
                "canonical_output_dir": str(canonical)}
    except (ValueError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preset-batch-mov-export")
async def preset_batch_mov_export(payload: BatchMovRequest):
    try:
        validate_media_basename(payload.basename)
        folder = Path(payload.output_dir).expanduser()
        if not folder.is_absolute() or not folder.is_dir():
            raise ValueError("Output folder must already exist")
        if payload.fps not in (24, 30, 60):
            raise ValueError("FPS must be 24, 30 or 60")
        psd = local_file(payload.psd, ".psd")
        wav = local_file(payload.wav, ".wav")
        canonical = folder.resolve(strict=True)
        async with app.state.export_lock:
            if payload.source_identity is None:
                raise ValueError("Registered WAV identity is required for batch")
            app.state.batch.before(
                payload.batch_id, payload.batch_index, canonical, payload.basename,
                wav, payload.source_identity, payload.fps, payload.conflict_policy)
            try:
                result = await asyncio.to_thread(
                    export_preset_utterance,
                    psd_path=psd, wav=wav, fingerprint=payload.fingerprint,
                    layers=payload.layers, mouth=payload.mouth, mode=payload.mode,
                    blink_enabled=payload.blink_enabled, conflict_policy=payload.conflict_policy,
                    mov=canonical / (payload.basename + ".mov"), otio=None,
                    fps=payload.fps, source_identity=payload.source_identity,
                )
                app.state.batch.succeeded(payload.batch_id, payload.batch_index, result)
                return result
            except (ValueError, FileExistsError, OSError, RuntimeError, TypeError):
                app.state.batch.failed(payload.batch_id, payload.batch_index)
                raise
    except (ValueError, FileExistsError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/preset-combined-otio")
async def preset_combined_otio(payload: CombinedOtioRequest):
    try:
        validate_media_basename(payload.basename)
        folder = Path(payload.output_dir).expanduser()
        if not folder.is_absolute() or not folder.is_dir():
            raise ValueError("Output folder must already exist")
        canonical = folder.resolve(strict=True)
        entries = [entry.model_dump() for entry in payload.entries]
        async with app.state.export_lock:
            expected = app.state.batch.before_timeline(
                payload.batch_id, canonical, payload.basename,
                payload.conflict_policy, entries)
            result = await asyncio.to_thread(
                create_combined_otio, canonical, payload.basename,
                entries, payload.conflict_policy, expected_identities=expected,
            )
            app.state.batch.release(payload.batch_id)
            return result
    except (ValueError, FileExistsError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.post("/api/export")
async def export(payload: ExportRequest):
    if payload.fps not in (24, 30, 60):
        raise HTTPException(400, "FPS must be 24, 30 or 60")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", payload.basename, re.ASCII):
        raise HTTPException(400, "Output basename must use 1-64 ASCII letters, digits, - or _")
    output_dir = Path(payload.output_dir).expanduser()
    if not output_dir.is_absolute() or not output_dir.is_dir():
        raise HTTPException(400, "Output folder must already exist")
    try:
        psd = local_file(payload.psd, ".psd")
        wav = local_file(payload.wav, ".wav")
        folder = output_dir.resolve(strict=True)
        mov, otio = folder / (payload.basename + ".mov"), folder / (payload.basename + ".otio")
        # Reject oversized canvases before WAV analysis, PSD composition or FFmpeg.
        # Use the same metadata-only PSD load and 60 MP cap as preview endpoints.
        # This Web API bound deliberately does not change the existing CLI contract.
        async with app.state.export_lock:
            app.state.batch.require_idle()
            await asyncio.to_thread(load_psd, str(psd))
            result = await asyncio.to_thread(
                export_mouth_animation,
                psd=psd, wav=wav,
                closed_path=payload.closed, open_path=payload.opened,
                mov=mov, otio=otio, fps=payload.fps,
            )
        return {
            "mov": str(mov),
            "otio": str(otio),
            "frames": result.video.frames,
            "sample_count": result.schedule.sample_count,
        }
    except (ValueError, FileExistsError, OSError, RuntimeError, TypeError) as exc:
        raise bad_request(exc) from exc


@app.get("/")
def index():
    index_file = FRONTEND_DIST / "index.html"
    if not index_file.is_file():
        return HTMLResponse(
            "Web UI not built. Run: cd frontend && npm install && npm run build",
            status_code=503,
        )
    return FileResponse(index_file)
