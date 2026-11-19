"""Thread-safe live progress and cooperative cancellation for local exports.

A token identifies one run; a terminal snapshot is retained until the next
export starts. No media bytes, source paths or user filenames are stored.
The export lock protects media operations; this separate lock allows progress
polls and cancel requests while the render worker holds that export lock.
"""
from dataclasses import dataclass, field
import re
from threading import Event, Lock


class ExportCancelled(Exception):
    """Cancellation was confirmed before any public publication began."""


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


class ExportProgress:
    """Single active export, shared by the solo and sequential batch routes."""

    def __init__(self):
        self._lock = Lock()
        self._job: _Job | None = None

    def start(self, token: str, kind: str, total: int = 1) -> None:
        if (type(token) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{20,100}", token)
                or kind not in ("single", "batch")
                or type(total) is not int or not 1 <= total <= 2000):
            raise ValueError("Invalid export progress identity")
        with self._lock:
            if self._job and self._job.status in ("running", "cancelling", "finalizing"):
                raise RuntimeError("Another export is active")
            if self._job and self._job.token == token:
                raise RuntimeError("Export progress identity was already used")
            self._job = _Job(token=token, kind=kind, total=total)

    def _current(self, token: str) -> _Job:
        job = self._job
        if job is None or job.token != token:
            raise KeyError("Export progress is not available")
        return job

    def snapshot(self, token: str) -> dict:
        with self._lock:
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
            job = self._current(token)
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
            if job.status not in ("running",):
                raise RuntimeError("Cannot update a completed export")
            if type(item_percent) is not int or not 0 <= item_percent <= 99:
                raise ValueError("Invalid export percent")
            mapped = (item_percent if job.kind == "single" else
                      (90 * (job.index * 100 + item_percent)) // (job.total * 100))
            job.percent = max(job.percent, mapped)
            job.stage = stage
            job.frames = frames
            job.frame_total = frame_total

    def finalizing(self, token: str, stage: str) -> None:
        """This is the last cancellation gate before public file mutation."""
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

    def finish(self, token: str, outcome: str) -> None:
        if outcome not in ("success", "failed", "cancelled"):
            raise ValueError("Invalid export result")
        with self._lock:
            job = self._current(token)
            if job.status in ("success", "failed", "cancelled"):
                return
            job.status = outcome
            job.finalizing = True
            if outcome == "success":
                job.percent = 100
                job.stage = "書き出し完了"
            elif outcome == "cancelled":
                job.stage = "書き出しをキャンセルしました"
            else:
                job.stage = "書き出しに失敗しました"
