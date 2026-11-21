"""Local HTTP adapter tests; only synthetic PSD and MOV media are used."""

import asyncio
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace

try:
    from fastapi.testclient import TestClient
    import httpx2  # noqa: F401; required by the current TestClient
except (ImportError, RuntimeError):
    TestClient = None

from tachie_motion.web.app import app
from tachie_motion.web.batch_session import BatchCoordinator
from tachie_motion.web.export_progress import ExportProgress
from tachie_motion.web.idle_api import IdleMotionExportRequest, idle_motion_export
from tachie_motion.web.service import describe_psd
from test_web_api import fixture


TOKEN = "12345678-1234-4234-9234-1234567890ab"


@unittest.skipUnless(TestClient is not None, "HTTP test extras required")
class IdleMotionApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        psd, wav, _, _ = fixture(self.root)
        self.psd, self.wav = psd, wav
        info = describe_psd(str(psd))
        self.payload = {
            "psd": str(psd),
            "fingerprint": info["fingerprint"],
            "source_identity": info["source_identity"],
            "layers": [{"path": layer["path"], "visible": layer["visible"]}
                       for layer in info["layers"]],
            "frame_count": 2,
            "fps": 30,
            "output_dir": str(self.root),
            "basename": "待機 た\u3099んもん",
        }
        self.original = (self.psd.read_bytes(), self.wav.read_bytes())
        prior_progress = app.state.export_progress
        prior_batch = app.state.batch
        prior_lock = app.state.export_lock
        self.addCleanup(setattr, app.state, "export_progress", prior_progress)
        self.addCleanup(setattr, app.state, "batch", prior_batch)
        self.addCleanup(setattr, app.state, "export_lock", prior_lock)
        app.state.export_progress = ExportProgress()
        app.state.batch = BatchCoordinator(
            on_expire=lambda token: app.state.export_progress.finish(token, "failed")
        )
        app.state.export_lock = asyncio.Lock()
        self.client = TestClient(app, base_url="http://127.0.0.1:8765")

    def post(self, **changes):
        return self.client.post("/api/idle-motion-export", json={**self.payload, **changes})

    def test_rejects_invalid_source_output_name_type_and_policy(self):
        invalid = (
            ({"frame_count": 0}, 400),
            ({"frame_count": 216_001}, 400),
            ({"frame_count": True}, 422),
            ({"frame_count": 2.5}, 422),
            ({"fps": 25}, 400),
            ({"fps": "30"}, 422),
            ({"blink_enabled": 1}, 422),
            ({"conflict_policy": "replace"}, 400),
            ({"basename": "../bad"}, 400),
            ({"psd": "relative.psd"}, 400),
            ({"output_dir": str(self.root / "missing")}, 400),
            ({"source_identity": "outdated"}, 400),
            ({"blink_enabled": True}, 400),
        )
        for changes, status in invalid:
            with self.subTest(changes=changes):
                self.assertEqual(self.post(**changes).status_code, status)
        self.assertEqual(list(self.root.glob("*.mov")), [])
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), self.original)

    def test_invalid_registration_and_blink_never_invoke_renderer(self):
        timing = {"interval_frames": 12, "closed_frames": 2,
                  "jitter_frames": 0, "phase_frames": 1, "seed": 11}
        malformed = (
            {"source_identity": "bad"},
            {"fingerprint": "bad"},
            {"layers": self.payload["layers"][:-1]},
            {"blink_enabled": True},
            {"blink_enabled": True, "blink_timing": {**timing, "seed": None}},
            {"blink_enabled": True, "blink_timing": {**timing, "interval_frames": 0}},
            {"blink_enabled": True, "blink_timing": timing},
            {"blink_enabled": True, "blink_timing": timing,
             "eyes": {"opened": [], "closed": [{"path": "0/1", "visible": True}]},
             "eye_groups": ["999"]},
        )
        for changes in malformed:
            with self.subTest(changes=changes):
                with patch("tachie_motion.web.idle_api.export_idle_motion") as renderer:
                    response = self.post(**changes)
                self.assertEqual(response.status_code, 400, response.text)
                renderer.assert_not_called()
        self.assertFalse((self.root / (self.payload["basename"] + ".mov")).exists())

    def test_reservation_finishes_only_after_publication_and_exposes_progress(self):
        self.assertEqual(self.client.post("/api/export-progress-reserve", json={
            "token": TOKEN, "kind": "single", "total": 1,
        }).status_code, 200)

        def fake_export(**kwargs):
            self.assertEqual(kwargs["frame_count"], 2)
            self.assertEqual(kwargs["mov"], self.root / (self.payload["basename"] + ".mov"))
            self.assertIsNone(kwargs["blink_timing"])
            for percent in (10, 25, 70):
                kwargs["on_progress"]("検証中", percent)
            self.assertEqual(app.state.export_progress.snapshot(TOKEN)["percent"], 70)
            kwargs["on_progress"]("公開中", 90)
            state = app.state.export_progress.snapshot(TOKEN)
            self.assertEqual((state["status"], state["percent"]), ("finalizing", 99))
            self.assertFalse(state["can_cancel"])
            kwargs["on_progress"]("完了", 100)
            return {"mov": str(kwargs["mov"]), "frames": 2, "fps": 30, "audio": False}

        with patch("tachie_motion.web.idle_api.export_idle_motion", side_effect=fake_export):
            result = self.post(progress_id=TOKEN)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertIs(result.json()["audio"], False)
        state = self.client.get("/api/export-progress/" + TOKEN).json()
        self.assertEqual((state["status"], state["percent"]), ("success", 100))

    def test_cancel_before_publication_is_reported_as_cancelled(self):
        def cancel_while_encoding(**kwargs):
            kwargs["on_progress"]("エンコード中", 25)
            response = self.client.post("/api/export-cancel", json={"token": TOKEN})
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json()["accepted"])
            kwargs["check_cancel"]()

        with patch("tachie_motion.web.idle_api.export_idle_motion",
                   side_effect=cancel_while_encoding):
            response = self.post(progress_id=TOKEN)
        self.assertEqual(response.status_code, 409)
        state = self.client.get("/api/export-progress/" + TOKEN).json()
        self.assertEqual(state["status"], "cancelled")
        self.assertLess(state["percent"], 100)

    def test_cancelled_reservation_never_enters_renderer(self):
        self.assertEqual(self.client.post("/api/export-progress-reserve", json={
            "token": TOKEN, "kind": "single", "total": 1,
        }).status_code, 200)
        self.assertEqual(self.client.post("/api/export-cancel", json={
            "token": TOKEN,
        }).json()["status"], "cancelled")
        with patch("tachie_motion.web.idle_api.export_idle_motion") as render:
            result = self.post(progress_id=TOKEN)
        self.assertEqual(result.status_code, 409)
        render.assert_not_called()
        self.assertFalse((self.root / (self.payload["basename"] + ".mov")).exists())

    def test_explicit_blink_settings_are_forwarded_unchanged(self):
        layers = describe_psd(str(self.psd))["layers"]
        face = next(item for item in layers if item["name"] == "face")
        selected = next(item for item in layers if item["kind"] == "pixel"
                        and item["visible"] and
                        item["path"].startswith(face["path"] + "/"))
        eyes = {"opened": [], "closed": [{"path": selected["path"], "visible": True}]}
        eye_groups = [face["path"]]
        timing = {"interval_frames": 12, "closed_frames": 2,
                  "jitter_frames": 0, "phase_frames": 1, "seed": 11}

        def inspect(**kwargs):
            self.assertTrue(kwargs["blink_enabled"])
            self.assertEqual(kwargs["eyes"], eyes)
            self.assertEqual(kwargs["eye_groups"], eye_groups)
            self.assertEqual(kwargs["blink_timing"], timing)
            return {"audio": False}

        with patch("tachie_motion.web.idle_api.export_idle_motion", side_effect=inspect):
            response = self.post(blink_enabled=True, eyes=eyes,
                                 eye_groups=eye_groups, blink_timing=timing)
        self.assertEqual(response.status_code, 200)

    def test_cancel_during_final_publication_is_rejected(self):
        def publish(**kwargs):
            kwargs["on_progress"]("公開中", 90)
            self.assertFalse(app.state.export_progress.request_cancel(TOKEN)["accepted"])
            kwargs["check_cancel"]()
            return {"mov": str(kwargs["mov"]), "frames": 2, "fps": 30, "audio": False}

        with patch("tachie_motion.web.idle_api.export_idle_motion", side_effect=publish):
            response = self.post(progress_id=TOKEN)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(app.state.export_progress.snapshot(TOKEN)["status"], "success")

    def test_backend_failure_finishes_progress_and_frees_export_lock(self):
        def fail(**kwargs):
            kwargs["on_progress"]("公開中", 90)
            raise RuntimeError("synthetic publication failure")

        with patch("tachie_motion.web.idle_api.export_idle_motion", side_effect=fail):
            result = self.post(progress_id=TOKEN)
        self.assertEqual(result.status_code, 400)
        self.assertEqual(app.state.export_progress.snapshot(TOKEN)["status"], "failed")
        with patch("tachie_motion.web.idle_api.export_idle_motion", return_value={"audio": False}):
            self.assertEqual(self.post().status_code, 200)

    def test_invalid_request_does_not_leave_a_blocking_reservation(self):
        reserve = self.client.post("/api/export-progress-reserve", json={
            "token": TOKEN, "kind": "single", "total": 1,
        })
        self.assertEqual(reserve.status_code, 200)
        response = self.post(progress_id=TOKEN, fps=25)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(app.state.export_progress.snapshot(TOKEN)["status"], "failed")
        with patch("tachie_motion.web.idle_api.export_idle_motion", return_value={"audio": False}):
            self.assertEqual(self.post().status_code, 200)

    def test_disconnected_request_keeps_worker_under_export_lock(self):
        started = threading.Event()
        release = threading.Event()

        def delayed_export(**kwargs):
            started.set()
            self.assertTrue(release.wait(timeout=5))
            return {"mov": str(kwargs["mov"]), "frames": 2, "fps": 30, "audio": False}

        async def run():
            with patch("tachie_motion.web.idle_api.export_idle_motion",
                       side_effect=delayed_export):
                payload = IdleMotionExportRequest(**self.payload)
                task = asyncio.create_task(idle_motion_export(payload, SimpleNamespace(app=app)))
                self.assertTrue(await asyncio.to_thread(started.wait, 5))
                task.cancel()  # Simulated lost HTTP request, not an export-cancel token.
                await asyncio.sleep(0)
                self.assertTrue(app.state.export_lock.locked())
                release.set()
                result = await asyncio.wait_for(task, timeout=5)
                self.assertEqual(result["audio"], False)
                self.assertFalse(app.state.export_lock.locked())

        try:
            asyncio.run(run())
        finally:
            release.set()

    def test_busy_batch_and_wrong_origin_never_call_renderer(self):
        with patch("tachie_motion.web.idle_api.export_idle_motion") as render:
            result = self.client.post("/api/idle-motion-export", json=self.payload,
                                      headers={"Origin": "https://evil.example"})
            self.assertEqual(result.status_code, 403)
            with patch.object(app.state.batch, "require_idle",
                              side_effect=RuntimeError("Batch in progress")):
                self.assertEqual(self.post().status_code, 400)
            render.assert_not_called()

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_real_silent_mov_and_existing_otio_are_safe(self):
        result = self.post()
        self.assertEqual(result.status_code, 200, result.text)
        output = self.root / (self.payload["basename"] + ".mov")
        self.assertTrue(output.is_file())
        streams = subprocess.run([
            "ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
            "-of", "csv=p=0", str(output),
        ], capture_output=True, text=True, check=True).stdout.splitlines()
        self.assertEqual(streams, ["video"])
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), self.original)
        old_bytes = output.read_bytes()
        output.with_suffix(".otio").write_bytes(b"third-party timeline")
        conflict = self.post(conflict_policy="overwrite")
        self.assertEqual(conflict.status_code, 400)
        self.assertEqual(output.read_bytes(), old_bytes)
        self.assertEqual(output.with_suffix(".otio").read_bytes(), b"third-party timeline")
