"""Safe source fingerprints for verified per-MOV generation history.

Stable history is OTIO metadata and never modifies the user project JSON.
The renderer revision must be bumped when render behavior or encoder output
semantics change; older records must not authorize reuse under a new engine.
"""
from pathlib import Path
from typing import Any

from tachie_motion.web.selective_recipe import (
    FileDigest, digest_regular_file, fingerprint_render_recipe,
)

RENDER_ENGINE_REVISION = "preset-timeline-prores-pcm-v1"


def capture_recipe_sources(payload: dict[str, Any]) -> tuple[FileDigest, FileDigest, FileDigest | None]:
    psd = Path(payload["psd"])
    wav = Path(payload["wav"])
    changes = payload.get("timeline_changes") or []
    if not isinstance(changes, list) or any(not isinstance(item, dict) for item in changes):
        raise ValueError("Invalid timeline changes for MOV recipe")
    lab_needed = payload["mode"] == "aiueo" or any(
        item.get("mode") == "aiueo" for item in changes)
    return (
        digest_regular_file(psd),
        digest_regular_file(wav),
        digest_regular_file(wav.with_suffix(".lab")) if lab_needed else None,
    )


def render_recipe(payload: dict[str, Any],
                  sources: tuple[FileDigest, FileDigest, FileDigest | None]) -> str:
    return fingerprint_render_recipe(
        payload, psd=sources[0], wav=sources[1], lab=sources[2],
        engine_revision=RENDER_ENGINE_REVISION,
    )
