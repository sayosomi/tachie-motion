"""One active batch export session per local Web server.

All state-changing session methods run under app.state.export_lock. A session
reserves the full set of destinations and binds each generated MOV inode to the
final combined OTIO. Stale browser tabs cannot silently interleave output.
"""
from dataclasses import dataclass, field
from pathlib import Path
import secrets
import time
import unicodedata

from tachie_motion.web.preview_frame import file_identity
from tachie_motion.timeline.media import probe_wav
from tachie_motion.web.service import local_file
from tachie_motion.web.solo_output import (
    _identity, initial_single_identity, validate_media_basename,
)

# The lease is renewed on each operation, after the current render completes.
IDLE_SECONDS = 600


def names_key(name: str) -> str:
    return unicodedata.normalize("NFC", validate_media_basename(name)).casefold()


def validate_names(media: list[str], timeline: str) -> None:
    if not isinstance(media, list) or not 1 <= len(media) <= 2000:
        raise ValueError("Batch needs 1–2000 MOV names")
    used = set()
    for name in [*media, timeline]:
        key = names_key(name)
        if key in used:
            raise ValueError("Unicode-casefold duplicate output basename: " + name)
        used.add(key)


def source_token(path: Path) -> str:
    return ":".join(map(str, file_identity(path)))


@dataclass(frozen=True)
class Planned:
    basename: str
    wav: Path
    source_identity: str
    fps: int
    samples: int
    sample_rate: int
    conflict_policy: str
    original: tuple | None


@dataclass
class Session:
    token: str
    folder: Path
    timeline_name: str
    timeline_policy: str
    timeline_original: tuple | None
    entries: list[Planned]
    deadline: float
    next_index: int = 0
    results: list[dict | None] = field(default_factory=list)
    identities: dict[str, tuple] = field(default_factory=dict)


class BatchCoordinator:
    def __init__(self):
        self.active: Session | None = None

    def _current(self) -> Session | None:
        if self.active and time.monotonic() > self.active.deadline:
            self.active = None
        return self.active

    def require_idle(self) -> None:
        if self._current() is not None:
            raise RuntimeError("Another batch is active; finish or cancel it first")

    def start(self, folder: Path, timeline_name: str, timeline_policy: str,
              entries: list[dict]) -> str:
        self.require_idle()
        names = [entry["basename"] for entry in entries]
        validate_names(names, timeline_name)
        folder = folder.resolve(strict=True)
        planned = []
        for raw in entries:
            wav = local_file(raw["wav"], ".wav")
            identity = raw["source_identity"]
            if not isinstance(identity, str) or not identity or identity != source_token(wav):
                raise ValueError("WAV changed since registration; batch not started")
            fps = raw["fps"]
            samples, sample_rate = raw["samples"], raw["sample_rate"]
            if fps not in (24, 30, 60) or (
                not isinstance(samples, int) or isinstance(samples, bool)
                or not isinstance(sample_rate, int) or isinstance(sample_rate, bool)
                or samples <= 0 or sample_rate <= 0
            ):
                raise ValueError("Invalid registered WAV timing")
            timing = probe_wav(wav)
            if source_token(wav) != identity:
                raise ValueError("WAV changed while validating batch sources")
            if timing.samples != samples or timing.sample_rate != sample_rate:
                raise ValueError("WAV timing changed since registration")
            prior = initial_single_identity(
                folder / (raw["basename"] + ".mov"), raw["conflict_policy"])
            planned.append(Planned(raw["basename"], wav, identity, fps, samples,
                                   sample_rate, raw["conflict_policy"], prior))
        timeline_prior = initial_single_identity(
            folder / (timeline_name + ".otio"), timeline_policy)
        token = secrets.token_urlsafe(32)
        self.active = Session(token, folder, timeline_name, timeline_policy,
                              timeline_prior, planned, time.monotonic() + IDLE_SECONDS)
        return token

    def _session(self, token: str) -> Session:
        session = self._current()
        if session is None or not secrets.compare_digest(session.token, token):
            raise RuntimeError("Batch session missing, expired, or owned by another tab")
        session.deadline = time.monotonic() + IDLE_SECONDS
        return session

    def before(self, token: str, index: int, folder: Path, basename: str, wav: Path,
               source_identity: str, fps: int, policy: str) -> None:
        session = self._session(token)
        if index != session.next_index or index < 0 or index >= len(session.entries):
            raise ValueError("Batch MOV order has changed")
        original = session.entries[index]
        if (folder != session.folder or original.basename != basename or
            original.wav != wav or original.source_identity != source_identity or
            original.fps != fps or original.conflict_policy != policy):
            raise ValueError("Batch MOV does not match the approved manifest")
        if source_token(wav) != source_identity:
            raise ValueError("WAV changed since registration")
        present = initial_single_identity(folder / (basename + ".mov"), policy)
        if present != original.original:
            raise ValueError("MOV destination changed after batch approval")

    def succeeded(self, token: str, index: int, result: dict) -> None:
        session = self._session(token)
        planned = session.entries[index]
        if index != session.next_index or (
            result["sample_count"], result["sample_rate"]) != (
                planned.samples, planned.sample_rate):
            raise RuntimeError("Batch output does not match the registered WAV")
        path = session.folder / (planned.basename + ".mov")
        identity = _identity(path)
        if identity is None:
            raise RuntimeError("Batch MOV disappeared after publication")
        session.identities[planned.basename] = identity
        session.results.append({
            "basename": planned.basename,
            "frames": result["frames"], "fps": planned.fps,
            "samples": result["sample_count"], "sample_rate": result["sample_rate"],
        })
        session.next_index += 1

    def failed(self, token: str, index: int) -> None:
        session = self._session(token)
        if index == session.next_index:
            session.results.append(None)
            session.next_index += 1

    def before_timeline(self, token: str, folder: Path, timeline_name: str,
                        policy: str, entries: list[dict]) -> dict[str, tuple]:
        session = self._session(token)
        if (folder != session.folder or timeline_name != session.timeline_name
            or policy != session.timeline_policy
            or session.next_index != len(session.entries)
            or any(item is None for item in session.results)
            or entries != session.results):
            raise ValueError("Batch is incomplete or the combined OTIO plan has changed")
        now = initial_single_identity(folder / (timeline_name + ".otio"), policy)
        if now != session.timeline_original:
            raise ValueError("OTIO destination changed after batch approval")
        for name, identity in session.identities.items():
            if _identity(folder / (name + ".mov")) != identity:
                raise ValueError("Batch MOV was replaced after rendering: " + name)
        return dict(session.identities)

    def release(self, token: str) -> bool:
        session = self._current()
        if session and secrets.compare_digest(session.token, token):
            self.active = None
            return True
        return False
