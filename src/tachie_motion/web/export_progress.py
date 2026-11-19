"""Thread-safe progress snapshots, retained results and cooperative cancellation.

An opaque token names one export. Finished results remain queryable across
subsequent exports for one hour. Only canonical browser UUIDs can reserve a
pre-start cancellation; arbitrary or already-completed tokens cannot be reused.
No file paths, media bytes or filenames are kept by this registry.
"""
from dataclasses import dataclass, field
import re
import time
from threading import Event, Lock


class ExportCancelled(Exception):
    """Worker has acknowledged cancellation before publication."""


_ID = re.compile(r"[A-Za-z0-9_-]{20,100}")
_BROWSER_ID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)
_TERMINAL_SECONDS = 3600
_RESERVED_SECONDS = 120
_MAX_RETAINED = 64
_TERMINAL = ("success", "failed", "cancelled")


@dataclass
class _Job:
    token: str
    kind: str
    total: int
    index: int = 0
    percent: int = 0
    stage: str = "準備・素材確認"
    status: str = "running"
    frames: int = 0
    frame_total: int = 0
    cancel: Event = field(default_factory=Event)
    finalizing: bool = False
    completed_at: float = 0.0
    reserved: bool = False
    reserved_until: float = 0.0


class ExportProgress:
    """One active writer and bounded, time-limited terminal snapshots."""

    def __init__(self):
        self._lock = Lock()
        self._job: _Job | None = None
        self._history: dict[str, _Job] = {}

    def _prune(self) -> None:
        now = time.monotonic()
        self._history = {
            key: job for key, job in self._history.items()
            if now - job.completed_at < _TERMINAL_SECONDS
        }
        # Reserved jobs have not launched a worker and may safely expire.
        if (self._job and self._job.reserved
                and now >= self._job.reserved_until
                and self._job.status == "running"):
            self._finish_unlocked(self._job, "failed")

    @staticmethod
    def _validate_identity(token: str, kind: str, total: int) -> None:
        if (type(token) is not str or _ID.fullmatch(token) is None
                or kind not in ("single", "batch")
                or type(total) is not int or not 1 <= total <= 2000):
            raise ValueError("Invalid export progress identity")

    def require_available(self, token: str | None) -> None:
        """Reject conflicting reservations before creating a batch stage."""
        with self._lock:
            self._prune()
            if (self._job and self._job.status not in _TERMINAL
                    and self._job.token != token):
                raise RuntimeError("Another export is active")

    def reserve(self, token: str, kind: str, total: int = 1) -> None:
        """Register a browser job before its render POST is sent.

        A cancellation can then be acknowledged immediately, even if the
        POST is delayed behind an export lock. A reservation cannot publish.
        """
        self._validate_identity(token, kind, total)
        if _BROWSER_ID.fullmatch(token) is None:
            raise ValueError("Browser progress token must be a UUIDv4")
        with self._lock:
            self._prune()
            if self._job and self._job.token == token and self._job.reserved:
                if (self._job.kind == kind and self._job.total == total
                        and self._job.status == "running"):
                    return  # Idempotent retry of a lost registration response.
                raise RuntimeError("Export reservation was cancelled or changed")
            if self._job and self._job.status not in _TERMINAL:
                raise RuntimeError("Another export is active")
            if (self._job and self._job.token == token) or token in self._history:
                raise RuntimeError("Export progress identity was already used")
            self._archive()
            self._job = _Job(token=token, kind=kind, total=total,
                             reserved=True,
                             reserved_until=time.monotonic() + _RESERVED_SECONDS)

    def _archive(self) -> None:
        if self._job is not None:
            self._history[self._job.token] = self._job
            if len(self._history) > _MAX_RETAINED:
                oldest = min(self._history, key=lambda k:
                             self._history[k].completed_at)
                del self._history[oldest]

    def start(self, token: str, kind: str, total: int = 1) -> None:
        self._validate_identity(token, kind, total)
        with self._lock:
            self._prune()
            if (self._job and self._job.token == token and
                    self._job.reserved_until > 0
                    and self._job.cancel.is_set() and self._job.status == "cancelled"):
                # A queued render POST that follows cancellation of its
                # pre-registered reservation must fail as "cancelled".
                raise ExportCancelled("書き出しをキャンセルしました")
            if self._job and self._job.token == token and self._job.reserved:
                if self._job.cancel.is_set() or self._job.status == "cancelled":
                    raise ExportCancelled("書き出しをキャンセルしました")
                if self._job.status != "running":
                    raise RuntimeError("Export reservation expired")
                if self._job.kind != kind or self._job.total != total:
                    raise ValueError("Export reservation mismatch")
                self._job.reserved = False
                return
            if self._job and self._job.status not in _TERMINAL:
                raise RuntimeError("Another export is active")
            if (self._job and self._job.token == token) or token in self._history:
                raise RuntimeError("Export progress identity was already used")
            self._archive()
            self._job = _Job(token=token, kind=kind, total=total)

    def _current(self, token: str) -> _Job:
        if self._job and self._job.token == token:
            return self._job
        if token in self._history:
            return self._history[token]
        raise KeyError("Export progress is not available")

    def kind(self, token: str) -> str:
        with self._lock:
            self._prune()
            return self._current(token).kind

    def snapshot(self, token: str) -> dict:
        with self._lock:
            self._prune()
            job = self._current(token)
            return {
                "status": job.status, "stage": job.stage,
                "percent": job.percent, "index": job.index + 1,
                "total": job.total, "frames": job.frames,
                "frame_total": job.frame_total,
                "can_cancel": job.status in ("running", "cancelling")
                              and not job.finalizing,
            }

    def request_cancel(self, token: str) -> dict:
        with self._lock:
            self._prune()
            job = self._current(token)
            if job.status == "running" and job.reserved:
                job.cancel.set()
                self._finish_unlocked(job, "cancelled")
                return {"status": "cancelled", "accepted": True,
                        "can_cancel": False}
            if job.status == "running" and not job.finalizing:
                job.cancel.set()
                job.status = "cancelling"
                job.stage = "キャンセル処理中"
            return self.snapshot_unlocked(job)

    @staticmethod
    def snapshot_unlocked(job: _Job) -> dict:
        return {"status": job.status, "accepted": job.cancel.is_set(),
                "can_cancel": job.status in ("running", "cancelling")
                              and not job.finalizing}

    def check(self, token: str) -> None:
        with self._lock:
            job = self._current(token)
            if job.cancel.is_set():
                raise ExportCancelled("書き出しをキャンセルしました")

    def item(self, token: str, index: int) -> None:
        with self._lock:
            job = self._current(token)
            if job.cancel.is_set():
                raise ExportCancelled("書き出しをキャンセルしました")
            if job.kind != "batch" or not 0 <= index < job.total:
                raise ValueError("Invalid batch progress index")
            job.index = index
            job.stage = "素材を検証中"
            job.frames = job.frame_total = 0

    def update(self, token: str, stage: str, item_percent: int,
               frames: int = 0, frame_total: int = 0) -> None:
        with self._lock:
            job = self._current(token)
            if job.cancel.is_set():
                raise ExportCancelled("書き出しをキャンセルしました")
            if job.status != "running":
                raise RuntimeError("Cannot update a completed export")
            if type(item_percent) is not int or not 0 <= item_percent <= 99:
                raise ValueError("Invalid export percent")
            mapped = (item_percent if job.kind == "single" else
                      (90 * (job.index * 100 + item_percent)) // (job.total * 100))
            job.percent = max(job.percent, mapped)
            job.stage = stage
            # Keep the last measured count while switching to PCM/OTIO steps.
            # A new batch item explicitly resets this in item().
            if frame_total:
                job.frames = frames
                job.frame_total = frame_total

    def finalizing(self, token: str, stage: str) -> None:
        """Last atomic cancellation gate before public files are modified."""
        with self._lock:
            job = self._current(token)
            if job.cancel.is_set():
                raise ExportCancelled("書き出しをキャンセルしました")
            if job.status != "running":
                raise RuntimeError("Export is not running")
            job.finalizing = True
            job.status = "finalizing"
            job.stage = stage
            job.percent = max(job.percent, 99 if job.kind == "single" else 95)

    def timeline(self, token: str) -> None:
        with self._lock:
            job = self._current(token)
            if job.cancel.is_set():
                raise ExportCancelled("書き出しをキャンセルしました")
            if job.kind != "batch" or job.status != "running":
                raise RuntimeError("Batch progress is not running")
            job.percent = max(job.percent, 90)
            job.stage = "全体OTIOを検証中"
            job.index = job.total - 1

    @staticmethod
    def _finish_unlocked(job: _Job, outcome: str) -> None:
        if job.status in _TERMINAL:
            return
        job.status = outcome
        job.finalizing = True
        job.reserved = False
        job.completed_at = time.monotonic()
        if outcome == "success":
            job.percent = 100
            job.stage = "書き出し完了"
        elif outcome == "cancelled":
            job.stage = "書き出しをキャンセルしました"
        else:
            job.stage = "書き出しに失敗しました"

    def finish(self, token: str, outcome: str) -> None:
        if outcome not in _TERMINAL:
            raise ValueError("Invalid export result")
        with self._lock:
            self._finish_unlocked(self._current(token), outcome)
