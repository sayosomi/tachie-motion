"""Read back authentic-looking generation history, then conservatively verify MOVs.

An OTIO is untrusted input: its history is only a *candidate*. Verify its
schema, both track references, current input bytes and output MOV bytes before
granting reuse. A corrupt/legacy OTIO never grants reuse.
"""
import json
from pathlib import Path
import stat
from typing import Any

from tachie_motion.timeline.media import probe_movie
from tachie_motion.web.combined_otio import probe_embedded_pcm
from tachie_motion.web.preview_frame import file_identity
from tachie_motion.web.selective_history import capture_recipe_sources, render_recipe
from tachie_motion.web.selective_recipe import digest_regular_file
from tachie_motion.web.selective_reuse import (
    SavedMovie, decode_history, verify_published_movie,
)
from tachie_motion.web.solo_output import validate_media_basename

_HISTORY_KEY = "tachie_motion_selective"
_MAX_OTIO_BYTES = 16 * 1024 * 1024


def load_saved_movies(folder: Path, timeline_name: str) -> dict[str, SavedMovie]:
    """No provenance on legacy/altered OTIOs; never accept arbitrary metadata.

    The stored entry order must match both audio and video clips, whose URLs
    must reference the identical published MOV, not stale stage media.
    """
    validate_media_basename(timeline_name)
    path = folder / (timeline_name + ".otio")
    try:
        before = digest_regular_file(path)
        if before.size > _MAX_OTIO_BYTES:
            return {}
        raw = path.read_bytes()
        if digest_regular_file(path) != before:
            return {}
        doc = json.loads(raw)
        if not isinstance(doc, dict) or doc.get("OTIO_SCHEMA") != "Timeline.1":
            return {}
        metadata = doc.get("metadata")
        if not isinstance(metadata, dict) or _HISTORY_KEY not in metadata:
            return {}
        saved = decode_history(metadata[_HISTORY_KEY])
        entries = metadata[_HISTORY_KEY]["entries"]
        tracks = doc["tracks"]["children"]
        if (not isinstance(tracks, list) or len(tracks) != 2 or
            tracks[0].get("kind") != "Video" or tracks[1].get("kind") != "Audio"):
            return {}
        for track in tracks:
            clips = track["children"]
            if not isinstance(clips, list) or len(clips) != len(entries):
                return {}
            for clip, entry in zip(clips, entries):
                expected = str(folder / (entry["basename"] + ".mov"))
                actual = clip["media_references"]["DEFAULT_MEDIA"]["target_url"]
                if actual != expected:
                    return {}
        return saved
    except (OSError, RuntimeError, ValueError, TypeError, KeyError, IndexError, AttributeError):
        return {}


def verified_reuse(
    folder: Path, timeline_name: str, *, item_id: str,
    render: dict[str, Any], expected_basename: str | None = None,
    saved_movies: dict[str, SavedMovie] | None = None,
) -> SavedMovie | None:
    """Server-owned strict check; never trusts a browser cache-hit assertion."""
    try:
        saved = (saved_movies if saved_movies is not None else
                 load_saved_movies(folder, timeline_name)).get(item_id)
        if saved is None or (
            expected_basename is not None and saved.basename != expected_basename
        ):
            return None
        wav = Path(render["wav"])
        if ":".join(map(str, file_identity(wav))) != render["source_identity"]:
            return None
        sources = capture_recipe_sources(render)
        recipe = render_recipe(render, sources)
        if not verify_published_movie(
            folder, saved, item_id=item_id, recipe_sha256=recipe,
            fps=render["fps"], samples=saved.samples, sample_rate=saved.sample_rate,
            video_probe=probe_movie, audio_probe=probe_embedded_pcm,
        ):
            return None
        # Source must remain stable throughout the MOV validation and probes.
        if capture_recipe_sources(render) != sources:
            return None
        return saved
    except (OSError, ValueError, RuntimeError, TypeError, KeyError, AttributeError):
        return None
