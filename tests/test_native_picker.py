"""Native Finder picker safety and parsing, using synthetic data only."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import threading

# Security checks are mandatory: missing httpx2/Starlette test dependencies
# must FAIL rather than silently skipping the entire picker API test class.
from fastapi.testclient import TestClient
import httpx2  # noqa: F401; required by the repository Web test environment

from tachie_motion.web.native_picker import (
    PickerUnavailable, choose_local_source,
)


class NativeDialogTests(unittest.TestCase):
    def test_filename_keeps_nfd_and_spaces_and_no_extra_trimming(self):
        with tempfile.TemporaryDirectory() as temp:
            original = Path(temp) / "あんこもん た\u3099んもん.psd"
            original.write_bytes(b"synthetic")
            with patch("tachie_motion.web.native_picker.sys.platform", "darwin"), patch(
                "tachie_motion.web.native_picker.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["osascript"], returncode=0, stdout=str(original) + "\n", stderr="",
                ),
            ) as launch:
                result = choose_local_source("psd")
            self.assertEqual(result, {"status": "selected", "path": str(original)})
            self.assertEqual(original.read_bytes(), b"synthetic")
            args = launch.call_args.args[0]
            self.assertEqual(args[0], "osascript")
            self.assertNotIn("shell", launch.call_args.kwargs)

    def test_start_folder_is_an_argument_and_never_script_source(self):
        with tempfile.TemporaryDirectory() as temp:
            location = Path(temp) / "立ち絵 空白 た\u3099"
            location.mkdir()
            chosen = location / "顔.psd"
            chosen.write_bytes(b"synthetic")
            with patch("tachie_motion.web.native_picker.sys.platform", "darwin"), patch(
                "tachie_motion.web.native_picker.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    ["osascript"], 0, stdout=str(chosen) + "\n", stderr="",
                ),
            ) as command:
                result = choose_local_source("psd", initial_dir=str(location))
            self.assertEqual(result["path"], str(chosen))
            args = command.call_args.args[0]
            self.assertEqual(args[-1], str(location))
            self.assertNotIn(str(location), args[2])
            self.assertIn("default location startFolder", args[2])
            self.assertIn("on run argv", args[2])

    def test_deleted_or_invalid_start_folder_falls_back(self):
        with tempfile.TemporaryDirectory() as temp:
            chosen = Path(temp) / "声.wav"
            chosen.write_bytes(b"synthetic")
            for invalid in (str(Path(temp) / "missing"), "relative", "", "\0invalid"):
                with self.subTest(invalid=invalid), patch(
                    "tachie_motion.web.native_picker.sys.platform", "darwin",
                ), patch(
                    "tachie_motion.web.native_picker.subprocess.run",
                    return_value=subprocess.CompletedProcess(
                        ["osascript"], 0, stdout=str(chosen) + "\n", stderr="",
                    ),
                ) as command:
                    self.assertEqual(choose_local_source("wav", initial_dir=invalid)["status"], "selected")
                    self.assertEqual(len(command.call_args.args[0]), 3)

    def test_cancelled_dialog_has_no_path(self):
        with patch("tachie_motion.web.native_picker.sys.platform", "darwin"), patch(
            "tachie_motion.web.native_picker.subprocess.run",
            return_value=subprocess.CompletedProcess(
                args=["osascript"], returncode=1,
                stdout="", stderr="execution error: User canceled. (-128)",
            ),
        ):
            self.assertEqual(choose_local_source("wav"), {"status": "cancelled"})

    def test_wrong_file_type_and_missing_file_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            incorrect = Path(temp) / "not-a-psd.txt"
            incorrect.write_text("synthetic")
            for path in (incorrect, Path(temp) / "missing.psd"):
                with self.subTest(path=path), patch(
                    "tachie_motion.web.native_picker.sys.platform", "darwin",
                ), patch("tachie_motion.web.native_picker.subprocess.run",
                    return_value=subprocess.CompletedProcess(["osascript"], 0,
                        stdout=str(path) + "\n", stderr="")):
                    with self.assertRaises(PickerUnavailable):
                        choose_local_source("psd")

    def test_existing_folder_allowed_and_unknown_kind_denied(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch("tachie_motion.web.native_picker.sys.platform", "darwin"), patch(
                "tachie_motion.web.native_picker.subprocess.run",
                return_value=subprocess.CompletedProcess(["osascript"], 0,
                    stdout=str(Path(temp)) + "/\n", stderr=""),
            ):
                self.assertEqual(choose_local_source("output_dir")["status"], "selected")
            with self.assertRaises(ValueError):
                choose_local_source("other")  # type: ignore[arg-type]

    def test_not_mac_and_dialog_failure(self):
        with patch("tachie_motion.web.native_picker.sys.platform", "linux"):
            with self.assertRaises(PickerUnavailable):
                choose_local_source("psd")
        with patch("tachie_motion.web.native_picker.sys.platform", "darwin"), patch(
            "tachie_motion.web.native_picker.subprocess.run",
            side_effect=subprocess.TimeoutExpired(["osascript"], timeout=300),
        ):
            with self.assertRaises(PickerUnavailable):
                choose_local_source("psd")


class PickerApiTests(unittest.TestCase):
    def setUp(self):
        from tachie_motion.web.picker_app import app
        self.client = TestClient(app, base_url="http://127.0.0.1:8766",
                                 client=("127.0.0.1", 50000))
        self.origin = "http://127.0.0.1:8765"

    def post(self, kind="psd", headers=None):
        return self.client.post("/pick", json={"kind": kind},
            headers={"Origin": self.origin, "X-Tachie-Picker": "1", **(headers or {})})

    def test_authorized_and_cancelled_pick(self):
        with patch("tachie_motion.web.picker_app.choose_local_source",
            return_value={"status": "selected", "path": "/tmp/test.psd"}) as choose:
            result = self.post()
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["path"], "/tmp/test.psd")
            self.assertEqual(result.headers["access-control-allow-origin"], self.origin)
            choose.assert_called_once_with("psd", initial_dir=None)
        with patch("tachie_motion.web.picker_app.choose_local_source",
            return_value={"status": "cancelled"}):
            self.assertEqual(self.post().json(), {"status": "cancelled"})

    def test_picker_api_passes_separate_source_directory(self):
        with tempfile.TemporaryDirectory() as temp, patch(
            "tachie_motion.web.picker_app.choose_local_source",
            return_value={"status": "selected", "path": "/tmp/test.wav"},
        ) as choose:
            response = self.client.post("/pick", json={
                "kind": "wav", "initial_dir": temp,
            }, headers={"Origin": self.origin, "X-Tachie-Picker": "1"})
            self.assertEqual(response.status_code, 200)
            choose.assert_called_once_with("wav", initial_dir=temp)

    def test_remote_host_origin_csrf_and_types_do_not_open_dialog(self):
        with patch("tachie_motion.web.picker_app.choose_local_source") as choose:
            for header in (
                {"Origin": "https://device.my-tailnet.ts.net:8443"},
                {"Origin": "https://evil.example"},
                {"Origin": "null"},
                {"Origin": ""},
                {"Host": "device.my-tailnet.ts.net:8443"},
                {"Host": "127.0.0.1:8765"},
                {"X-Tachie-Picker": ""},
                {"Content-Type": "text/plain"},
            ):
                with self.subTest(header=header):
                    self.assertNotEqual(self.post(headers=header).status_code, 200)
            self.assertEqual(self.post("invalid").status_code, 422)
            self.assertEqual(self.client.get("/pick", headers={
                "Origin": self.origin}).status_code, 404)
            self.assertEqual(self.client.get("/health").status_code, 403)
            choose.assert_not_called()

    def test_non_loopback_client_is_denied_without_dialog(self):
        from tachie_motion.web.picker_app import app
        remote = TestClient(app, base_url="http://127.0.0.1:8766",
                            client=("100.64.0.3", 50000))
        with patch("tachie_motion.web.picker_app.choose_local_source") as choose:
            reply = remote.post("/pick", json={"kind": "psd"}, headers={
                "Origin": self.origin, "X-Tachie-Picker": "1",
            })
            self.assertEqual(reply.status_code, 403)
            choose.assert_not_called()

    def test_busy_dialog_and_no_route_on_main_app(self):
        import tachie_motion.web.picker_app as picker_app
        from tachie_motion.web.app import app as main_app
        with patch.object(picker_app.dialog_lock, "locked", return_value=True), patch(
            "tachie_motion.web.picker_app.choose_local_source",
        ) as choose:
            self.assertEqual(self.post().status_code, 409)
            choose.assert_not_called()
        # Android Serve reaches only this main application on 8765.
        with TestClient(main_app, base_url="http://127.0.0.1:8765") as main:
            result = main.post("/pick", json={"kind": "psd"})
            self.assertEqual(result.status_code, 404)

    def test_concurrent_real_requests_do_not_open_two_dialogs(self):
        entered = threading.Event()
        release = threading.Event()
        responses = []
        errors = []

        def block_first(kind, *, initial_dir=None):
            entered.set()
            if not release.wait(timeout=5):
                raise AssertionError("Concurrent picker test timed out")
            return {"status": "cancelled"}

        def first():
            try:
                responses.append(self.post())
            except Exception as exc:
                errors.append(exc)

        with patch("tachie_motion.web.picker_app.choose_local_source",
                   side_effect=block_first) as choose:
            worker = threading.Thread(target=first, daemon=True)
            worker.start()
            try:
                self.assertTrue(entered.wait(timeout=5),
                                "First picker did not enter its dialog")
                second = self.post()
                self.assertEqual(second.status_code, 409, second.text)
            finally:
                release.set()
                worker.join(timeout=5)
            self.assertFalse(worker.is_alive())
            self.assertFalse(errors, errors)
            self.assertEqual(len(responses), 1)
            self.assertEqual(responses[0].status_code, 200)
            choose.assert_called_once_with("psd", initial_dir=None)

    def test_preflight_rejects_foreign_and_accepts_only_known_headers(self):
        origin = self.origin
        headers = {
            "Origin": origin, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-tachie-picker",
        }
        response = self.client.options("/pick", headers=headers)
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers["access-control-allow-origin"], origin)
        self.assertEqual(self.client.options("/pick", headers={
            **headers, "Access-Control-Request-Headers": "authorization",
        }).status_code, 403)
        self.assertEqual(self.client.options("/pick", headers={
            **headers, "Origin": "https://device.my-tailnet.ts.net:8443",
        }).status_code, 403)

    def test_dialog_error_is_http_503_without_path_leak(self):
        with patch("tachie_motion.web.picker_app.choose_local_source",
            side_effect=PickerUnavailable("dialog unavailable")):
            response = self.post()
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["detail"], "dialog unavailable")



class MacLauncherTests(unittest.TestCase):
    """Launcher processes are mocked; no ports or user processes are touched."""

    @classmethod
    def setUpClass(cls):
        import importlib.util
        script = Path(__file__).resolve().parents[1] / "scripts" / "run_mac_web.py"
        spec = importlib.util.spec_from_file_location("picker_mac_launcher_test", script)
        assert spec is not None and spec.loader is not None
        cls.launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.launcher)

    def test_busy_socket_is_rejected_without_touching_occupant(self):
        import socket
        with socket.socket() as occupant:
            occupant.bind(("127.0.0.1", 0))
            occupant.listen()
            with self.assertRaisesRegex(RuntimeError, "already in use"):
                self.launcher.require_free(occupant.getsockname()[1])
            # The occupant is still listening.
            self.assertEqual(occupant.fileno() >= 0, True)

    def test_second_child_spawn_failure_stops_owned_first_child(self):
        from unittest.mock import Mock
        web = Mock()
        web.poll.return_value = None
        web.wait.return_value = 0
        with patch.object(self.launcher.sys, "platform", "darwin"), patch.object(
            self.launcher, "require_free",
        ), patch("pathlib.Path.is_dir", return_value=True), patch.object(
            self.launcher.subprocess, "run",
        ), patch.object(self.launcher.subprocess, "Popen",
            side_effect=[web, OSError("picker launch failed")]):
            self.assertEqual(self.launcher.main(), 1)
        web.terminate.assert_called_once()
        web.kill.assert_not_called()

    def test_unexpected_child_exit_cleans_only_owned_live_child(self):
        from unittest.mock import Mock
        web = Mock()
        picker = Mock()
        web.poll.return_value = 1
        picker.poll.return_value = None
        picker.wait.return_value = 0
        with patch.object(self.launcher.sys, "platform", "darwin"), patch.object(
            self.launcher, "require_free",
        ), patch("pathlib.Path.is_dir", return_value=True), patch.object(
            self.launcher.subprocess, "run",
        ), patch.object(self.launcher.subprocess, "Popen",
            side_effect=[web, picker]):
            self.assertEqual(self.launcher.main(), 1)
        web.terminate.assert_not_called()
        picker.terminate.assert_called_once()
        picker.kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
