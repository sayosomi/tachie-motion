"""Conservative reuse decisions and stable public names for utterance MOVs.

This module never decides that a browser-provided claim is sufficient.
Callers must authenticate saved history, compute the current render recipe from
server-verified source bytes, validate the destination lease, and recheck file
ownership at publication. A reused MOV retains its public basename (D31).
"""
from dataclasses import asdict, dataclass
from pathlib import Path
import re
import unicodedata
from typing import Callable, Any

from tachie_motion.web.selective_recipe import digest_regular_file
from tachie_motion.web.solo_output import validate_media_basename

HISTORY_FORMAT = "tachie-motion-selective-history-v1"
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")


@dataclass(frozen=True)
class SavedMovie:
    item_id: str
    basename: str
    recipe_sha256: str
    mov_sha256: str
    frames: int
    fps: int
    samples: int
    sample_rate: int


def _validate_saved(record: SavedMovie) -> None:
    if not isinstance(record.item_id, str) or not record.item_id or len(record.item_id) > 256:
        raise ValueError("Invalid saved utterance ID")
    validate_media_basename(record.basename)
    if not (_DIGEST.fullmatch(record.recipe_sha256) and
            _DIGEST.fullmatch(record.mov_sha256)):
        raise ValueError("Invalid saved MOV digest")
    for key in ("frames", "samples", "sample_rate"):
        number = getattr(record, key)
        if type(number) is not int or number <= 0:
            raise ValueError("Invalid saved MOV timing")
    if type(record.fps) is not int or record.fps not in (24, 30, 60):
        raise ValueError("Invalid saved MOV FPS")


def encode_history(records: list[SavedMovie]) -> dict:
    """JSON-compatible OTIO metadata; no source files or absolute paths."""
    if not 1 <= len(records) <= 2000:
        raise ValueError("Invalid number of history entries")
    ids: set[str] = set()
    names: set[str] = set()
    for entry in records:
        _validate_saved(entry)
        folded = unicodedata.normalize("NFC", entry.basename).casefold()
        if entry.item_id in ids or folded in names:
            raise ValueError("Duplicate history ID or public MOV name")
        ids.add(entry.item_id)
        names.add(folded)
    return {"format": HISTORY_FORMAT, "entries": [asdict(item) for item in records]}


def decode_history(raw: Any) -> dict[str, SavedMovie]:
    """Reject malformed/unrecognized history; it must never grant reuse."""
    if not isinstance(raw, dict) or set(raw) != {"format", "entries"} or raw["format"] != HISTORY_FORMAT:
        raise ValueError("Unrecognized MOV generation history")
    records = raw["entries"]
    if not isinstance(records, list) or not 1 <= len(records) <= 2000:
        raise ValueError("Invalid MOV history entries")
    expected = set(SavedMovie.__dataclass_fields__)
    parsed: list[SavedMovie] = []
    for entry in records:
        if not isinstance(entry, dict) or set(entry) != expected:
            raise ValueError("Invalid MOV history entry")
        parsed.append(SavedMovie(**entry))
    encode_history(parsed)  # Also rejects duplicate IDs, names and bad values.
    return {entry.item_id: entry for entry in parsed}


def verify_published_movie(
    folder: Path, saved: SavedMovie, *,
    item_id: str, recipe_sha256: str, fps: int,
    samples: int, sample_rate: int,
    video_probe: Callable[[Path], Any],
    audio_probe: Callable[[Path], Any],
) -> bool:
    """Require exact recipe, public file bytes and both media time bases.

    This is a *read-only candidate check*, not authorization for publishing.
    Source digests, OTIO provenance, output conflicts and final TOCTOU checks
    remain responsibilities of the server's batch coordinator.
    """
    try:
        _validate_saved(saved)
        if (saved.item_id != item_id or saved.recipe_sha256 != recipe_sha256 or
            saved.fps != fps or saved.samples != samples or
            saved.sample_rate != sample_rate):
            return False
        mov = folder / (saved.basename + ".mov")
        if digest_regular_file(mov).sha256 != saved.mov_sha256:
            return False
        video = video_probe(mov)
        audio = audio_probe(mov)
        return (video.frames == saved.frames and video.fps == fps and
                audio.samples == samples and audio.sample_rate == sample_rate)
    except (OSError, ValueError, RuntimeError, TypeError, AttributeError):
        return False


@dataclass(frozen=True)
class NamingCandidate:
    item_id: str
    suggested_basename: str
    previous: SavedMovie | None
    reuse_verified: bool
    manually_named: bool = False


@dataclass(frozen=True)
class NamingDecision:
    item_id: str
    basename: str
    reuse: bool


def select_public_names(
    requests: list[NamingCandidate], timeline_basename: str,
) -> list[NamingDecision]:
    """A: verified unchanged MOVs keep existing names; conflicts fail closed.

    A manually pinned name cannot be silently changed back to a prior name.
    A dirty/new item uses its proposed name. If that name collides with the
    stable name of a reused item, fail rather than overwrite or rename media.
    """
    if not 1 <= len(requests) <= 2000:
        raise ValueError("Invalid number of planned MOVs")
    validate_media_basename(timeline_basename)
    names = {unicodedata.normalize("NFC", timeline_basename).casefold()}
    ids: set[str] = set()
    decisions: list[NamingDecision] = []
    for entry in requests:
        if not isinstance(entry.item_id, str) or not entry.item_id or entry.item_id in ids:
            raise ValueError("Invalid or duplicate utterance ID")
        if type(entry.reuse_verified) is not bool or type(entry.manually_named) is not bool:
            raise ValueError("Invalid reuse flag")
        validate_media_basename(entry.suggested_basename)
        previous = entry.previous
        if entry.reuse_verified and previous is None:
            raise ValueError("Reuse claimed without a saved MOV")
        reuse = (entry.reuse_verified and previous is not None and
                 previous.item_id == entry.item_id and
                 (not entry.manually_named or
                  previous.basename == entry.suggested_basename))
        name = previous.basename if reuse and previous is not None else entry.suggested_basename
        validate_media_basename(name)
        folded = unicodedata.normalize("NFC", name).casefold()
        if folded in names:
            raise ValueError("Output basename collision with retained public MOV: " + name)
        ids.add(entry.item_id)
        names.add(folded)
        decisions.append(NamingDecision(entry.item_id, name, reuse))
    return decisions
