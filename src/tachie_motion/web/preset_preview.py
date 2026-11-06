"""Read-only, exact-snapshot base visibility preview for unified presets.

This module does not define mouth/eye override precedence or mutate source PSDs.
"""

from functools import lru_cache
from pathlib import Path

from tachie_motion.presets import LayerState, LayerStateSet, Preset
from tachie_motion.psd.tree import walk_layers
from tachie_motion.psd.visibility import parse_index_path, resolve_layer
from tachie_motion.web.preview_frame import (
    file_identity, prepare_updated, preview_lock, publish,
)
from tachie_motion.web.service import load_psd, local_file, thumbnail


# Six PNG data URIs remain in the exact-state LRU. A separate, bounded
# single-RGBA-frame cache is shared with the initial PSD preview and protected
# by the same lock. No mutable PSDImage instances are cached.
_preview_lock = preview_lock


def psd_snapshot_token(raw: str) -> str:
    """A lightweight change detector, not a persistent PSD identity."""
    source = local_file(raw, ".psd")
    meta = source.stat()
    return f"{meta.st_size}:{meta.st_mtime_ns}"


def _file_identity(source: Path) -> tuple[int, int, int, int, int]:
    return file_identity(source)

@lru_cache(maxsize=6)
def _cached_render(
    source_path: str, token: str,
    identity: tuple[int, int, int, int, int],
    states: tuple[LayerState, ...],
) -> str:
    source = Path(source_path)
    if _file_identity(source) != identity:
        raise ValueError("PSD has changed; reload it before editing presets")
    psd = load_psd(source_path)
    if _file_identity(source) != identity:
        raise ValueError("PSD changed during load; reload before editing")
    expected = {summary.index_path for summary in walk_layers(psd)}
    received = {item.path for item in states}
    if received != expected:
        raise ValueError("Preset layers do not match PSD snapshot")

    # Never share the mutable PSD between different visibility states.
    for layer_state in states:
        resolve_layer(psd, layer_state.path).visible = layer_state.visible
    result, candidate = prepare_updated(
        psd, source_path, identity, states,
        fallback=lambda: thumbnail(psd),
    )
    if _file_identity(source) != identity:
        raise ValueError("PSD changed during preview; reload before editing")
    publish(candidate)
    return result


def preview_base_preset(
    raw: str, token: str, edits: list[dict], source_identity: str | None = None,
) -> dict:
    """Render explicitly given ON/OFF states, reusing exact snapshot previews.

    The key includes the resolved source, file identity, PSD fingerprint and
    every layer's path/visibility. Group visibility remains authoritative.
    Cache hits return only previously validated complete states.
    """
    if not isinstance(token, str) or not token:
        raise ValueError("PSD fingerprint required")
    source = local_file(raw, ".psd")
    identity = _file_identity(source)
    if f"{identity[3]}:{identity[4]}" != token:
        raise ValueError("PSD has changed; reload it before editing presets")
    if (source_identity is not None
            and source_identity != ":".join(map(str, identity))):
        raise ValueError("PSD identity has changed; reload before editing presets")
    if not isinstance(edits, list) or len(edits) > 50_000:
        raise ValueError("Invalid preset layer count")

    layers = []
    for entry in edits:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise ValueError("Each preset layer requires an index path")
        if type(entry.get("visible")) is not bool:
            raise ValueError("Layer visibility must be ON or OFF")
        layers.append(LayerState(parse_index_path(entry["path"]), entry["visible"]))
    preset = Preset("preview-only", "preview-only", LayerStateSet(tuple(layers)))
    # Normalize order without changing the complete, validated state.
    states = tuple(sorted(preset.base.layers, key=lambda layer: layer.path))

    with _preview_lock:
        image = _cached_render(str(source), token, identity, states)
    # A cached result cannot outlive a source modification during the request.
    if _file_identity(source) != identity:
        raise ValueError("PSD changed during preview; reload before editing")
    return {"preview": image}
