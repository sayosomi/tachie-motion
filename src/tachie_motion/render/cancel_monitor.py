"""Interrupt blocking FFmpeg/ffprobe I/O when a render is cancelled.

The checker raises the original ExportCancelled; the watcher only kills the
child to unblock a pipe read/write/wait. Its caller always reaps the child.
"""
from collections.abc import Callable
import subprocess
from threading import Event, Thread


class ProcessCancelWatcher:
    def __init__(self, proc: subprocess.Popen, check_cancel: Callable[[], None] | None):
        self.proc = proc
        self.callback = check_cancel
        self.stop = Event()
        self.thread: Thread | None = None
        self.error: BaseException | None = None

    def __enter__(self):
        if self.callback is not None:
            try:
                self.callback()
            except BaseException:
                if self.proc.poll() is None:
                    self.proc.kill()
                # __enter__ failed before the caller acquired the watcher:
                # it must reap the child itself to avoid leaving a zombie.
                self.proc.communicate()
                raise
            self.thread = Thread(target=self._watch, daemon=True)
            self.thread.start()
        return self

    def _watch(self):
        while not self.stop.wait(0.1):
            try:
                assert self.callback is not None
                self.callback()
            except BaseException as exc:
                self.error = exc
                try:
                    if self.proc.poll() is None:
                        self.proc.kill()
                except ProcessLookupError:
                    pass
                return

    def check(self):
        if self.error is not None:
            raise self.error
        if self.callback is not None:
            self.callback()

    def __exit__(self, exc_type, exc, tb):
        self.stop.set()
        if self.thread is not None:
            self.thread.join()
