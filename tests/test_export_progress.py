"""Progress/cancellation contracts independent of browser and Mac source media."""
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    import httpx2  # required by the current Starlette TestClient
except (ImportError, RuntimeError):
    TestClient = None
from tachie_motion.web.app import app

from PIL import Image

from tachie_motion.render.pcm_mux import _command
from tachie_motion.render.sequence import encode_prores_sequence
from tachie_motion.web.export_progress import ExportCancelled, ExportProgress


TOKEN = "p" * 32
OTHER = "q" * 32


class ExportProgressTests(unittest.TestCase):
    def setUp(self):
        self.jobs = ExportProgress()

    def test_cancel_requires_worker_ack_and_is_token_scoped(self):
        self.jobs.start(TOKEN, "single")
        self.jobs.update(TOKEN, "映像フレームをFFmpegへ送信中", 47, 10, 20)
        with self.assertRaises(KeyError):
            self.jobs.snapshot(OTHER)
        with self.assertRaises(KeyError):
            self.jobs.request_cancel(OTHER)
        reply = self.jobs.request_cancel(TOKEN)
        self.assertTrue(reply["accepted"])
        self.assertEqual("cancelling", self.jobs.snapshot(TOKEN)["status"])
        self.assertNotEqual(100, self.jobs.snapshot(TOKEN)["percent"])
        with self.assertRaises(ExportCancelled):
            self.jobs.check(TOKEN)
        with self.assertRaises(ExportCancelled):
            self.jobs.update(TOKEN, "映像完成", 99)
        self.assertEqual("cancelling", self.jobs.snapshot(TOKEN)["status"])
        self.jobs.finish(TOKEN, "cancelled")
        self.assertEqual("cancelled", self.jobs.snapshot(TOKEN)["status"])
        self.assertEqual(47, self.jobs.snapshot(TOKEN)["percent"])
        with self.assertRaises(RuntimeError):
            self.jobs.start(TOKEN, "single")

    def test_final_publication_cannot_be_cancelled_halfway(self):
        self.jobs.start(TOKEN, "single")
        self.jobs.update(TOKEN, "検証済み", 93)
        self.jobs.finalizing(TOKEN, "MOVを保存中")
        result = self.jobs.request_cancel(TOKEN)
        self.assertFalse(result["accepted"])
        self.assertEqual("finalizing", result["status"])
        self.jobs.finish(TOKEN, "success")
        self.assertEqual(100, self.jobs.snapshot(TOKEN)["percent"])
        self.assertFalse(self.jobs.request_cancel(TOKEN)["accepted"])

    def test_cancel_at_publication_boundary_wins_before_commit(self):
        self.jobs.start(TOKEN, "single")
        self.jobs.request_cancel(TOKEN)
        with self.assertRaises(ExportCancelled):
            self.jobs.finalizing(TOKEN, "MOVを保存中")
        self.jobs.finish(TOKEN, "cancelled")
        self.assertNotEqual(100, self.jobs.snapshot(TOKEN)["percent"])

    def test_batch_progress_reserved_for_otio_commit(self):
        self.jobs.start(TOKEN, "batch", 2)
        self.jobs.item(TOKEN, 0)
        self.jobs.update(TOKEN, "映像生成", 99)
        first = self.jobs.snapshot(TOKEN)
        self.assertLess(first["percent"], 45)
        self.jobs.item(TOKEN, 1)
        self.jobs.update(TOKEN, "映像生成", 90)
        self.jobs.timeline(TOKEN)
        self.assertEqual(90, self.jobs.snapshot(TOKEN)["percent"])
        self.jobs.finalizing(TOKEN, "公開中")
        self.assertEqual(95, self.jobs.snapshot(TOKEN)["percent"])
        self.assertFalse(self.jobs.request_cancel(TOKEN)["accepted"])
        self.jobs.finish(TOKEN, "success")
        self.assertEqual(100, self.jobs.snapshot(TOKEN)["percent"])

    def test_duplicate_active_job_and_invalid_identifiers(self):
        self.jobs.start(TOKEN, "single")
        with self.assertRaises(RuntimeError):
            self.jobs.start(OTHER, "single")
        with self.assertRaises(KeyError):
            self.jobs.finish(OTHER, "success")
        self.jobs.finish(TOKEN, "failed")
        self.jobs.start(OTHER, "batch", 1)
        with self.assertRaises(KeyError):
            self.jobs.snapshot(TOKEN)
        with self.assertRaises(ValueError):
            self.jobs.start("short", "single")


class ExportProcessCancellationTests(unittest.TestCase):
    def test_inflight_media_subprocess_is_killed_on_cancel(self):
        cancel = threading.Event()

        def check():
            if cancel.is_set():
                raise ExportCancelled("cancelled")

        timer = threading.Timer(0.3, cancel.set)
        timer.start()
        start = time.monotonic()
        try:
            with self.assertRaises(ExportCancelled):
                _command([sys.executable, "-c", "import time; time.sleep(12)"],
                         check_cancel=check)
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - start, 5.0)

    @unittest.skipUnless(shutil.which("ffmpeg"), "Real FFmpeg unavailable")
    def test_cancel_during_frame_submission_does_not_publish_mov(self):
        jobs = ExportProgress()
        jobs.start(TOKEN, "single")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            png = root / "source.png"
            output = root / "out.mov"
            Image.new("RGBA", (32, 32), (120, 30, 10, 140)).save(png)

            def on_frame(count, total):
                jobs.update(TOKEN, "映像生成", 20 + count, count, total)
                if count == 3:
                    jobs.request_cancel(TOKEN)

            with self.assertRaises(ExportCancelled):
                encode_prores_sequence(
                    [png], [0] * 24, output, fps=24,
                    on_frame=on_frame, check_cancel=lambda: jobs.check(TOKEN))
            jobs.finish(TOKEN, "cancelled")
            self.assertFalse(output.exists())
            self.assertFalse(list(root.glob(".tachie-sequence-*.mov")))
            self.assertTrue(png.exists())


@unittest.skipUnless(TestClient is not None, "FastAPI test extra unavailable")
class ExportProgressApiTests(unittest.TestCase):
    def test_cancel_reaches_running_worker_before_publication(self):
        from threading import Event, Thread

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            psd = root / "portrait.psd"
            wav = root / "speech.wav"
            psd.write_bytes(b"test psd placeholder")
            wav.write_bytes(b"test wav placeholder")
            started = Event()
            outputs = []

            def slow_export(*, progress=None, **kwargs):
                self.assertIsNotNone(progress)
                registry, token = progress
                registry.update(token, "映像フレームをFFmpegへ送信中", 32, 4, 16)
                started.set()
                for _ in range(100):
                    registry.check(token)
                    time.sleep(0.03)
                raise AssertionError("Cancellation did not reach the worker")

            token = "api_" + "0" * 32
            payload = {
                "psd": str(psd), "wav": str(wav), "fingerprint": "synthetic",
                "layers": [], "mode": "none", "output_dir": str(root),
                "basename": "speech", "source_identity": "1:2:3:4:5",
                "progress_id": token,
            }
            with patch("tachie_motion.web.app.export_preset_utterance",
                       side_effect=slow_export), TestClient(app, base_url="http://127.0.0.1:8765") as client:
                worker = Thread(target=lambda: outputs.append(
                    client.post("/api/preset-utterance-export", json=payload)))
                worker.start()
                try:
                    self.assertTrue(started.wait(5), "Server did not start render")
                    status = client.get("/api/export-progress/" + token)
                    self.assertEqual(200, status.status_code)
                    self.assertEqual(32, status.json()["percent"])
                    self.assertEqual(404, client.get(
                        "/api/export-progress/" + "x" * 32).status_code)
                    self.assertEqual(404, client.post("/api/export-cancel",
                        json={"token": "x" * 32}).status_code)
                    accepted = client.post("/api/export-cancel",
                        json={"token": token})
                    self.assertEqual(200, accepted.status_code)
                    self.assertTrue(accepted.json()["accepted"])
                    self.assertEqual("cancelling", accepted.json()["status"])
                finally:
                    worker.join(timeout=5)
                self.assertFalse(worker.is_alive(), "Cancelled worker did not exit")
                self.assertEqual(409, outputs[0].status_code)
                self.assertEqual("cancelled", client.get(
                    "/api/export-progress/" + token).json()["status"])
                self.assertFalse((root / "speech.mov").exists())




if __name__ == "__main__":
    unittest.main()
