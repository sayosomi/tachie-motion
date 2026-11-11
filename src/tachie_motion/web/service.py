"""Read local media and generate bounded PNG previews without source writes."""

from base64 import b64encode
from dataclasses import asdict
from io import BytesIO
from pathlib import Path

from psd_tools import PSDImage

from tachie_motion.presets import LayerState
from tachie_motion.psd.raster import composite_rgba
from tachie_motion.web.preview_frame import (
    file_identity, prepare_initial, preview_lock, publish,
)
from tachie_motion.psd.tree import walk_layers
from tachie_motion.psd.visibility import (
    apply_visibility, parse_index_path, resolve_layer,
)
from tachie_motion.timeline.media import probe_wav


MAX_CANVAS_PIXELS = 60_000_000


def local_file(raw: str, suffix: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError("Use an absolute local file path")
    if path.suffix.lower() != suffix or not path.is_file():
        raise ValueError("Expected an existing " + suffix + " file")
    return path.resolve(strict=True)


def load_psd(raw: str) -> PSDImage:
    path = local_file(raw, ".psd")
    psd = PSDImage.open(path)
    if psd.width * psd.height > MAX_CANVAS_PIXELS:
        raise ValueError("PSD canvas exceeds the preview safety limit")
    return psd


def thumbnail(psd: PSDImage) -> str:
    image = composite_rgba(psd)
    image.thumbnail((900, 900))
    with BytesIO() as stream:
        image.save(stream, format="PNG")
        return "data:image/png;base64," + b64encode(stream.getvalue()).decode("ascii")


def describe_psd(raw: str) -> dict:
    source = local_file(raw, ".psd")
    # Share the single-frame lock with preset requests. Never seed a frame
    # whose source changed during loading, compositing or PNG encoding.
    with preview_lock:
        identity = file_identity(source)
        psd = load_psd(str(source))
        if file_identity(source) != identity:
            raise ValueError("PSD changed during load; reload before editing")
        summaries = list(walk_layers(psd))
        layers = []
        for summary in summaries:
            data = asdict(summary)
            data["path"] = "/".join(map(str, summary.index_path))
            del data["index_path"]
            layers.append(data)
        states = tuple(LayerState(summary.index_path, summary.visible)
                       for summary in summaries)
        preview, candidate = prepare_initial(
            psd, str(source), identity, states,
            fallback=lambda: thumbnail(psd),
        )
        if file_identity(source) != identity:
            raise ValueError("PSD changed during preview; reload before editing")
        publish(candidate)
    return {
        "width": psd.width,
        "height": psd.height,
        "layers": layers,
        "fingerprint": f"{identity[3]}:{identity[4]}",
        "source_identity": ":".join(map(str, identity)),
        "preview": preview,
    }


def preview_mouth(raw: str, closed: str, opened: str, state: str) -> dict:
    if state not in ("closed", "open"):
        raise ValueError("Preview state must be closed or open")
    psd = load_psd(raw)
    a, b = parse_index_path(closed), parse_index_path(opened)
    if a == b:
        raise ValueError("Mouth layers must be distinct")
    for path in (a, b):
        if resolve_layer(psd, path).is_group():
            raise ValueError("Choose leaf mouth layers, not groups")
    if state == "closed":
        apply_visibility(psd, show=[closed], hide=[opened])
    else:
        apply_visibility(psd, show=[opened], hide=[closed])
    return {"preview": thumbnail(psd)}


def describe_wav(raw: str) -> dict:
    path = local_file(raw, ".wav")
    before = file_identity(path)
    timing = probe_wav(path)
    if file_identity(path) != before:
        raise ValueError("WAV changed during inspection")
    return {
        "samples": timing.samples,
        "sample_rate": timing.sample_rate,
        "duration_seconds": timing.samples / timing.sample_rate,
        # Full stat identity detects edits/replacements missed by duration and
        # sample-rate checks. Never treat sample counts alone as file identity.
        "source_identity": ":".join(map(str, before)),
    }
