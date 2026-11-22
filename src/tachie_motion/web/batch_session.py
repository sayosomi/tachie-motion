"""One active batch export session per local Web server.

All state-changing session methods run under app.state.export_lock. A session
reserves the full set of destinations and binds each generated MOV inode to the
final combined OTIO. Stale browser tabs cannot silently interleave output.
"""
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
import secrets
import time
import unicodedata

from tachie_motion.web.preview_frame import file_identity
from tachie_motion.web.selective_recipe import FileDigest, digest_regular_file
from tachie_motion.web.selective_plan import load_saved_movies
from tachie_motion.web.selective_reuse import SavedMovie, encode_history
from tachie_motion.web.aiueo_renderer import inspect_export_lab
from tachie_motion.web.batch_publish import (
    create_stage, discard_stage, publish_batch, require_batch_recovery_clear,
)
from tachie_motion.timeline.media import probe_wav
from tachie_motion.web.service import local_file
from tachie_motion.web.solo_output import (
    _identity, initial_single_identity, published_media_identity, validate_media_basename,
    refuse_equivalent_output_name,
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


def has_foreign_otio(folder: Path, timeline_name: str) -> bool:
    """Conservative read-only check shared by preview and the start gate.

    Other OTIO files may reference a MOV slated for overwrite. Do not infer
    safety from names or parse untrusted external timeline references here.
    """
    target_name = timeline_name + ".otio"
    return any(path.suffix.lower() == ".otio" and path.name != target_name
               for path in folder.iterdir())


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
    lab_source_identity: str | None = None
    item_id: str | None = None
    reuse: bool = False
    saved: SavedMovie | None = None


@dataclass
class Session:
    token: str
    folder: Path
    timeline_name: str
    timeline_policy: str
    timeline_original: tuple | None
    entries: list[Planned]
    stage: Path
    deadline: float
    next_index: int = 0
    results: list[dict | None] = field(default_factory=list)
    identities: dict[str, tuple] = field(default_factory=dict)
    generation_records: list[SavedMovie] = field(default_factory=list)
    source_snapshots: dict[int, tuple[tuple[Path, FileDigest], ...]] = field(
        default_factory=dict)


class BatchCoordinator:
    def __init__(self, on_expire: Callable[[str], None] | None = None):
        self.active: Session | None = None
        self.on_expire = on_expire

    def _current(self) -> Session | None:
        if self.active and time.monotonic() > self.active.deadline:
            # Expiry releases the lease but keeps the stage and its media
            # for inspection; no public files are changed.
            session = self.active
            self.active = None
            try:
                discard_stage(session.stage)
            finally:
                if self.on_expire is not None:
                    self.on_expire(session.token)
        return self.active

    def expire_idle(self) -> None:
        """Expire only when the caller holds the app export lock."""
        self._current()

    def require_idle(self) -> None:
        if self._current() is not None:
            raise RuntimeError("Another batch is active; finish or cancel it first")

    def start(self, folder: Path, timeline_name: str, timeline_policy: str,
              entries: list[dict], token: str | None = None) -> str:
        self.require_idle()
        names = [entry["basename"] for entry in entries]
        validate_names(names, timeline_name)
        folder = folder.resolve(strict=True)
        require_batch_recovery_clear(folder)
        for filename in [*(name + ".mov" for name in names),
                         timeline_name + ".otio"]:
            refuse_equivalent_output_name(folder / filename)
        planned = []
        # Capture prior metadata before creating any stage or public file.
        saved_history = load_saved_movies(folder, timeline_name) if any(
            item.get("reuse", False) for item in entries) else {}
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
            lab_token = raw.get("lab_source_identity")
            if lab_token is not None:
                if (type(lab_token) is not str or len(lab_token) > 128 or
                        not all(part.isdecimal() and part.isascii()
                                for part in lab_token.split(":")) or
                        len(lab_token.split(":")) != 5):
                    raise ValueError("Invalid registered LAB identity")
                _, lab_identity = inspect_export_lab(wav, identity)
                if lab_token != ":".join(map(str, lab_identity)):
                    raise ValueError("LAB changed since selection; batch not started")
            item_id = raw.get("item_id")
            if item_id is not None and (
                type(item_id) is not str or not item_id or len(item_id) > 256
            ):
                raise ValueError("Invalid stable utterance ID")
            reuse = raw.get("reuse", False)
            if type(reuse) is not bool:
                raise ValueError("Invalid batch reuse decision")
            saved = saved_history.get(item_id) if reuse else None
            if reuse and (
                saved is None or saved.basename != raw["basename"] or
                prior is None or raw["conflict_policy"] != "overwrite" or
                saved.fps != fps or saved.samples != samples or
                saved.sample_rate != sample_rate
            ):
                raise ValueError("Previously generated MOV is not reusable")
            planned.append(Planned(raw["basename"], wav, identity, fps, samples,
                                   sample_rate, raw["conflict_policy"], prior,
                                   lab_source_identity=lab_token, item_id=item_id,
                                   reuse=reuse, saved=saved))
        ids = [entry.item_id for entry in planned]
        if any(value is not None for value in ids) and (
            any(value is None for value in ids) or len(set(ids)) != len(ids)
        ):
            raise ValueError("Generation history requires distinct IDs for all utterances")
        timeline_prior = initial_single_identity(
            folder / (timeline_name + ".otio"), timeline_policy)
        # The same conservative rule is exposed to the browser as a preflight
        # hint, but must remain authoritative here (TOCTOU after preview).
        if (any(item.conflict_policy == "overwrite" and not item.reuse
                for item in planned) and has_foreign_otio(folder, timeline_name)):
            raise ValueError("Another OTIO may reference an overwritten MOV; "
                             "choose an isolated export folder")
        stage = create_stage(folder, allowed_files=(
            [item.basename + ".mov" for item in planned if not item.reuse] +
            [timeline_name + ".otio"]))
        try:
            token = token if token is not None else secrets.token_urlsafe(32)
            self.active = Session(token, folder, timeline_name, timeline_policy,
                                  timeline_prior, planned, stage,
                                  time.monotonic() + IDLE_SECONDS)
            return token
        except BaseException:
            # Stage contents are retained, but its live file-descriptor lease
            # must not leak when token/session initialization fails.
            discard_stage(stage)
            raise

    def _session(self, token: str) -> Session:
        session = self._current()
        if session is None or not secrets.compare_digest(session.token, token):
            raise RuntimeError("Batch session missing, expired, or owned by another tab")
        session.deadline = time.monotonic() + IDLE_SECONDS
        return session

    def _finish_render_session(self, token: str) -> Session:
        # A legitimate render can take longer than the idle-session timeout.
        # The app holds export_lock for the entire render; do not expire the
        # owner before recording a MOV that may already have been published.
        session = self.active
        if session is None or not secrets.compare_digest(session.token, token):
            raise RuntimeError("Batch render ownership was lost")
        session.deadline = time.monotonic() + IDLE_SECONDS
        return session

    def before(self, token: str, index: int, folder: Path, basename: str, wav: Path,
               source_identity: str, fps: int, policy: str,
               lab_source_identity: str | None = None) -> None:
        session = self._session(token)
        if index != session.next_index or index < 0 or index >= len(session.entries):
            raise ValueError("Batch MOV order has changed")
        original = session.entries[index]
        if (folder != session.folder or original.basename != basename or
            original.wav != wav or original.source_identity != source_identity or
            original.fps != fps or original.conflict_policy != policy or
            original.lab_source_identity != lab_source_identity):
            raise ValueError("Batch MOV does not match the approved manifest")
        if source_token(wav) != source_identity:
            raise ValueError("WAV changed since registration")
        self._verify_lab(original)
        present = initial_single_identity(folder / (basename + ".mov"), policy)
        if present != original.original:
            raise ValueError("MOV destination changed after batch approval")
        if original.reuse:
            if load_saved_movies(folder, session.timeline_name).get(original.item_id) != original.saved:
                raise ValueError("Previously generated MOV history changed")
        if (session.stage / (basename + ".mov")).exists():
            raise ValueError("Batch staging name already occupied")

    def succeeded(self, token: str, index: int, result: dict,
                  recipe_sha256: str | None = None) -> None:
        session = self._finish_render_session(token)
        planned = session.entries[index]
        if planned.reuse or index != session.next_index or (
            result["sample_count"], result["sample_rate"]) != (
                planned.samples, planned.sample_rate):
            raise RuntimeError("Batch output does not match the registered WAV")
        path = session.stage / (planned.basename + ".mov")
        identity = published_media_identity(path)
        if identity is None:
            raise RuntimeError("Batch MOV disappeared after publication")
        saved = None
        if planned.item_id is not None:
            if not isinstance(recipe_sha256, str):
                raise ValueError("Missing server-computed generation recipe")
            saved = SavedMovie(
                item_id=planned.item_id, basename=planned.basename,
                recipe_sha256=recipe_sha256,
                mov_sha256=digest_regular_file(path).sha256,
                frames=result["frames"], fps=planned.fps,
                samples=result["sample_count"], sample_rate=result["sample_rate"],
            )
            encode_history([saved])  # Validate before advancing the session.
        session.identities[planned.basename] = identity
        if saved is not None:
            session.generation_records.append(saved)
        session.results.append({
            "basename": planned.basename,
            "frames": result["frames"], "fps": planned.fps,
            "samples": result["sample_count"], "sample_rate": result["sample_rate"],
        })
        session.next_index += 1

    def reuse_succeeded(self, token: str, index: int, verified: SavedMovie) -> dict:
        """Record a verified public MOV without making any staged media link."""
        session = self._finish_render_session(token)
        planned = session.entries[index]
        if (index != session.next_index or not planned.reuse or
                verified != planned.saved or planned.item_id != verified.item_id):
            raise ValueError("Reused MOV is not the approved historical output")
        path = session.folder / (planned.basename + ".mov")
        identity = published_media_identity(path)
        if identity is None or digest_regular_file(path).sha256 != verified.mov_sha256:
            raise ValueError("Previously generated MOV changed during reuse")
        session.identities[planned.basename] = identity
        session.generation_records.append(verified)
        session.results.append({
            "basename": planned.basename, "frames": verified.frames,
            "fps": verified.fps, "samples": verified.samples,
            "sample_rate": verified.sample_rate,
        })
        session.next_index += 1
        return {
            "frames": verified.frames, "sample_count": verified.samples,
            "sample_rate": verified.sample_rate,
        }

    def remember_sources(
        self, token: str, index: int, payload: dict,
        digests: tuple[FileDigest, FileDigest, FileDigest | None],
    ) -> None:
        session = self._finish_render_session(token)
        if index != session.next_index or session.entries[index].item_id is None:
            raise ValueError("Source history is not authorized for this MOV")
        if index in session.source_snapshots:
            raise ValueError("Source history has already been recorded")
        wav = Path(payload["wav"])
        sources = [(Path(payload["psd"]), digests[0]), (wav, digests[1])]
        if digests[2] is not None:
            sources.append((wav.with_suffix(".lab"), digests[2]))
        session.source_snapshots[index] = tuple(sources)

    @staticmethod
    def _verify_source_snapshots(session: Session) -> None:
        if not session.entries or session.entries[0].item_id is None:
            return  # Legacy API has no generation history.
        if len(session.source_snapshots) != len(session.entries):
            raise ValueError("Batch source digest manifest is incomplete")
        # Deduplicate the common PSD across many WAVs without weakening checks.
        checked: dict[Path, FileDigest] = {}
        for snapshots in session.source_snapshots.values():
            for path, initial in snapshots:
                if path not in checked:
                    checked[path] = digest_regular_file(path)
                if checked[path] != initial:
                    raise ValueError("Source bytes changed after MOV rendering: " + path.name)

    def failed(self, token: str, index: int) -> None:
        session = self._finish_render_session(token)
        if index == session.next_index:
            session.results.append(None)
            session.next_index += 1

    @staticmethod
    def _verify_lab(planned: Planned) -> None:
        if planned.lab_source_identity is None:
            return
        _, identity = inspect_export_lab(planned.wav, planned.source_identity)
        if ":".join(map(str, identity)) != planned.lab_source_identity:
            raise ValueError("LAB changed since selection; batch not published")

    def before_timeline(self, token: str, folder: Path, timeline_name: str,
                        policy: str, entries: list[dict]) -> dict[str, tuple]:
        session = self._session(token)
        if (folder != session.folder or timeline_name != session.timeline_name
            or policy != session.timeline_policy
            or session.next_index != len(session.entries)
            or any(item is None for item in session.results)
            or entries != session.results):
            raise ValueError("Batch is incomplete or the combined OTIO plan has changed")
        self._verify_source_snapshots(session)
        now = initial_single_identity(folder / (timeline_name + ".otio"), policy)
        if now != session.timeline_original:
            raise ValueError("OTIO destination changed after batch approval")
        for planned in session.entries:
            name = planned.basename
            source_folder = folder if planned.reuse else session.stage
            if published_media_identity(source_folder / (name + ".mov")) != session.identities[name]:
                raise ValueError("Batch MOV was replaced after rendering: " + name)
            if planned.reuse and digest_regular_file(
                    folder / (name + ".mov")).sha256 != planned.saved.mov_sha256:
                raise ValueError("Reused MOV content changed: " + name)
        for planned in session.entries:
            # Recheck all WAVs after MOV staging, before publishing the timeline.
            if source_token(planned.wav) != planned.source_identity:
                raise ValueError("WAV changed since registration; batch not published")
            self._verify_lab(planned)
            dest = folder / (planned.basename + ".mov")
            if initial_single_identity(dest, planned.conflict_policy) != planned.original:
                raise ValueError("Public destination changed during batch: " + dest.name)
        return dict(session.identities)

    def needs_generation_record(self, token: str) -> bool:
        session = self._session(token)
        return bool(session.entries and session.entries[0].item_id is not None)

    def generation_history(self, token: str) -> dict | None:
        session = self._session(token)
        if not self.needs_generation_record(token):
            return None
        if (len(session.generation_records) != len(session.entries) or
                len(session.results) != len(session.entries)):
            raise ValueError("Batch generation history is incomplete")
        return encode_history(session.generation_records)

    def reused_names(self, token: str) -> set[str]:
        return {entry.basename for entry in self._session(token).entries if entry.reuse}

    def reuse_plan(self, token: str, index: int) -> SavedMovie | None:
        session = self._session(token)
        if index < 0 or index >= len(session.entries):
            raise ValueError("Invalid MOV index")
        return session.entries[index].saved if session.entries[index].reuse else None

    def staged_folder(self, token: str) -> Path:
        return self._session(token).stage

    def commit(self, token: str) -> str | None:
        session = self._session(token)
        if len(session.results) != len(session.entries) or any(x is None for x in session.results):
            raise ValueError("Incomplete batch cannot be published")
        staged = {entry.basename + ".mov": session.identities[entry.basename]
                  for entry in session.entries if not entry.reuse}
        otio_name = session.timeline_name + ".otio"
        expected_otio = published_media_identity(session.stage / otio_name)
        if expected_otio is None:
            raise ValueError("Combined OTIO was not staged")
        staged[otio_name] = expected_otio
        original = {planned.basename + ".mov": planned.original
                    for planned in session.entries if not planned.reuse}
        original[otio_name] = session.timeline_original
        # Last source identity gate before public batch publication.
        self._verify_source_snapshots(session)
        for planned in session.entries:
            if source_token(planned.wav) != planned.source_identity:
                raise ValueError("WAV changed since registration; batch not published")
            self._verify_lab(planned)
            if planned.reuse:
                current = session.folder / (planned.basename + ".mov")
                if (published_media_identity(current) != session.identities[planned.basename] or
                        digest_regular_file(current).sha256 != planned.saved.mov_sha256):
                    raise ValueError("Reused public MOV changed before OTIO publication")
        # Recheck external media and references *inside* the publication
        # transaction, including after the OTIO link while rollback is possible.
        def validate_external(final: bool) -> None:
            if (any(not item.reuse and item.original is not None
                    for item in session.entries) and
                    has_foreign_otio(session.folder, session.timeline_name)):
                raise ValueError("Another OTIO appeared during batch publication")
            for item in session.entries:
                if not item.reuse:
                    continue
                public = session.folder / (item.basename + ".mov")
                refuse_equivalent_output_name(public)
                if (published_media_identity(public) != session.identities[item.basename]
                        or (final and
                            digest_regular_file(public).sha256 != item.saved.mov_sha256)):
                    raise ValueError("Reused MOV changed during publication: " + item.basename)

        # This changes only dirty/new MOVs and the combined OTIO, never reused MOVs.
        return publish_batch(
            folder=session.folder, stage=session.stage,
            movie_names=[planned.basename for planned in session.entries if not planned.reuse],
            timeline_name=session.timeline_name,
            original=original, expected_stage=staged,
            validate_external=validate_external,
        )

    def release(self, token: str) -> bool:
        session = self.active
        if session and secrets.compare_digest(session.token, token):
            self.active = None
            discard_stage(session.stage)
            return True
        return False
