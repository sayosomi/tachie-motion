"""Synthetic tests for the single-command on-demand Android launcher.

Never starts Tailscale, a Web server, or binds external ports.
"""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch


SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "run_android_web.py"
SPEC = importlib.util.spec_from_file_location("run_android_web", SOURCE)
assert SPEC and SPEC.loader
launch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launch)
HOST = "mock-device.mock-tailnet.ts.net"


def foreground_8443(session="existing", port=8765, funnel=False):
    return {
        "Foreground": {
            session: {
                "TCP": {"8443": {"HTTPS": True}},
                "Web": {
                    HOST + ":8443": {
                        "Handlers": {"/": {"Proxy": f"http://127.0.0.1:{port}"}}
                    }
                },
                **({"AllowFunnel": {HOST + ":8443": True}} if funnel else {}),
            },
        },
    }


def config_443_and_8443():
    return {
        "TCP": {"443": {"HTTPS": True}, "8443": {"HTTPS": True}},
        "Web": {
            HOST + ":443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8002"}}},
            HOST + ":8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8765"}}},
        },
    }


class RouteIsolationTests(unittest.TestCase):
    def test_voiceger_443_only_is_absent_8443_and_remains_unmodified(self):
        original = config_443_and_8443()
        original["TCP"].pop("8443")
        original["Web"].pop(HOST + ":8443")
        before = repr(original)
        self.assertEqual(launch.serve_8443_state(original, HOST), "absent")
        self.assertEqual(repr(original), before)

    def test_reuse_exact_existing_route_and_avoid_touching_voiceger(self):
        original = config_443_and_8443()
        before = repr(original)
        self.assertEqual(launch.serve_8443_state(original, HOST), "existing")
        self.assertEqual(repr(original), before)

    def test_wrong_route_https_host_and_funnel_are_blocked(self):
        mismatches = []
        base = config_443_and_8443()
        a = {**base, "Web": {**base["Web"],
             HOST + ":8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:9000"}}}}}
        mismatches.append(a)
        b = {**base, "Web": {HOST + ":443": base["Web"][HOST + ":443"],
                          "other.ts.net:8443": base["Web"][HOST + ":8443"]}}
        mismatches.append(b)
        c = {**base, "TCP": {"443": {"HTTPS": True}, "8443": {"HTTP": True}}}
        mismatches.append(c)
        d = {**base, "AllowFunnel": {HOST + ":8443": True}}
        mismatches.append(d)
        e = {**base, "Web": {**base["Web"],
            HOST + ":8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8765"},
                                         "/admin": {"Proxy": "http://127.0.0.1:8765"}}}}}
        mismatches.append(e)
        for config in mismatches:
            with self.subTest(config=config), self.assertRaises(launch.LaunchBlocked):
                launch.serve_8443_state(config, HOST)

    def test_missing_config_returns_absent(self):
        self.assertEqual(launch.serve_8443_state(None, HOST), "absent")
        self.assertEqual(launch.serve_8443_state({}, HOST), "absent")

    def test_foreground_exact_route_is_reused_without_mutation(self):
        configured = foreground_8443()
        configured["TCP"] = {"443": {"HTTPS": True}}
        configured["Web"] = {
            HOST + ":443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8002"}}}
        }
        before = repr(configured)
        self.assertEqual(launch.serve_8443_state(configured, HOST), "existing")
        self.assertEqual(repr(configured), before)

    def test_foreground_conflicting_8443_is_rejected(self):
        with self.assertRaisesRegex(launch.LaunchBlocked, "different Serve route"):
            launch.serve_8443_state(foreground_8443(port=9000), HOST)

    def test_foreground_funnel_is_rejected_even_if_route_matches(self):
        with self.assertRaisesRegex(launch.LaunchBlocked, "Funnel"):
            launch.serve_8443_state(foreground_8443(funnel=True), HOST)

    def test_duplicate_matching_background_and_foreground_is_rejected(self):
        config = config_443_and_8443()
        config.update(foreground_8443())
        with self.assertRaisesRegex(launch.LaunchBlocked, "multiple Serve sessions"):
            launch.serve_8443_state(config, HOST)

    def test_duplicate_matching_foreground_sessions_are_rejected(self):
        config = foreground_8443()
        config["Foreground"]["second"] = foreground_8443("other")["Foreground"]["other"]
        with self.assertRaisesRegex(launch.LaunchBlocked, "multiple Serve sessions"):
            launch.serve_8443_state(config, HOST)

    def test_invalid_foreground_shape_and_nested_session_fail_closed(self):
        for config in (
            {"Foreground": []},
            {"Foreground": {"session": None}},
            {"Foreground": {"session": {"Foreground": {"nested": {}}}}},
            {"Foreground": {"session": {"TCP": []}}},
            {"Foreground": {"session": {"AllowFunnel": {HOST + ":8443": True}}}},
        ):
            with self.subTest(config=config), self.assertRaises(launch.LaunchBlocked):
                launch.serve_8443_state(config, HOST)

    def test_even_empty_nested_foreground_is_rejected(self):
        for value in ({}, [], None, False, 0, ""):
            with self.subTest(nested=value), self.assertRaisesRegex(
                launch.LaunchBlocked, "nested Foreground"
            ):
                launch.serve_8443_state(
                    {"Foreground": {"session": {"Foreground": value}}}, HOST
                )

    def test_explicit_invalid_top_level_foreground_is_rejected(self):
        for value in (None, [], False, 0, ""):
            with self.subTest(foreground=value), self.assertRaisesRegex(
                launch.LaunchBlocked, "Invalid Foreground"
            ):
                launch.serve_8443_state({"Foreground": value}, HOST)

    def test_https_flag_requires_json_boolean_true(self):
        for value in (1, 0, "true", "false", None, [], {}, False):
            config = foreground_8443()
            config["Foreground"]["existing"]["TCP"]["8443"]["HTTPS"] = value
            with self.subTest(https=value), self.assertRaises(launch.LaunchBlocked):
                launch.serve_8443_state(config, HOST)
        # A real JSON boolean remains valid; integer 1 must not alias it.
        self.assertEqual(launch.serve_8443_state(foreground_8443(), HOST), "existing")

    def test_funnel_flag_requires_json_boolean_even_if_falsy(self):
        for value in (1, 0, "false", "", None, [], {}):
            config = foreground_8443()
            config["Foreground"]["existing"]["AllowFunnel"] = {HOST + ":8443": value}
            with self.subTest(funnel=value), self.assertRaises(launch.LaunchBlocked):
                launch.serve_8443_state(config, HOST)
        config = foreground_8443()
        config["Foreground"]["existing"]["AllowFunnel"] = {HOST + ":8443": False}
        self.assertEqual(launch.serve_8443_state(config, HOST), "existing")
        config["Foreground"]["existing"]["AllowFunnel"][HOST + ":8443"] = True
        with self.assertRaisesRegex(launch.LaunchBlocked, "Funnel"):
            launch.serve_8443_state(config, HOST)

    def test_invalid_funnel_boolean_on_unrelated_port_is_rejected(self):
        config = config_443_and_8443()
        config["AllowFunnel"] = {HOST + ":443": 0}
        with self.assertRaises(launch.LaunchBlocked):
            launch.serve_8443_state(config, HOST)

    def test_dns_and_connected_state_are_checked(self):
        self.assertEqual(launch.tailscale_hostname({
            "BackendState": "Running",
            "Self": {"DNSName": HOST.upper() + "."},
        }), HOST)
        for state in (
            {"BackendState": "Stopped", "Self": {"DNSName": HOST + "."}},
            {"BackendState": "Running", "Self": {"DNSName": "evil.example.com"}},
            {"BackendState": "Running", "Self": {"DNSName": ""}},
        ):
            with self.subTest(state=state), self.assertRaises(launch.LaunchBlocked):
                launch.tailscale_hostname(state)

    def test_occupied_local_port_fails_without_terminating_other_process(self):
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            with patch.object(launch, "PORT", sock.getsockname()[1]):
                with self.assertRaisesRegex(launch.LaunchBlocked, "already in use"):
                    launch.available_local_port()


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.serve_snapshots: list[dict] = []
        (self.repo / ".venv" / "bin").mkdir(parents=True)
        (self.repo / ".venv" / "bin" / "python").touch()
        (self.repo / "frontend" / "node_modules").mkdir(parents=True)
        self.patchers = [
            patch.object(launch, "REPO", self.repo),
            patch.object(launch, "available_local_port"),
            patch.object(launch, "health_check", return_value=True),
            patch.object(launch, "capture", side_effect=self.capture),
            patch.object(launch.subprocess, "run"),
            patch.object(launch.subprocess, "Popen"),
            patch.object(launch.time, "sleep", side_effect=KeyboardInterrupt),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def capture(self, *args):
        if args[:2] == ("tailscale", "status"):
            return '{"BackendState":"Running","Self":{"DNSName":"' + HOST + '."}}'
        if args[:3] == ("tailscale", "serve", "status"):
            import json
            if self.serve_snapshots:
                return json.dumps(self.serve_snapshots.pop(0))
            if launch.subprocess.Popen.call_count >= 2:
                # Simulate registration of the newly launched foreground
                # Serve session; the production CLI must expose this config.
                return json.dumps(foreground_8443("launcher"))
            return "{}"
        if args[:2] == ("git", "-C"):
            return "abc123"
        raise AssertionError(f"Unexpected command: {args!r}")

    def test_one_command_starts_local_then_8443_and_stops_only_owned_processes(self):
        web = MagicMock()
        proxy = MagicMock()
        web.poll.return_value = None
        proxy.poll.return_value = None
        launch.subprocess.Popen.side_effect = [web, proxy]
        self.assertEqual(launch.run(), 0)
        self.assertEqual(launch.subprocess.Popen.call_count, 2)
        local_args = launch.subprocess.Popen.call_args_list[0].args[0]
        proxy_args = launch.subprocess.Popen.call_args_list[1].args[0]
        self.assertEqual(local_args[-2:], ["-m", "tachie_motion.web.cli"])
        self.assertEqual(proxy_args, [
            "tailscale", "serve", "--https=8443", "http://127.0.0.1:8765",
        ])
        env = launch.subprocess.Popen.call_args_list[0].kwargs["env"]
        self.assertEqual(env["TACHIE_TAILSCALE_ORIGIN"], "https://" + HOST + ":8443")
        self.assertNotIn("--https=443", proxy_args)
        self.assertNotIn("--bg", proxy_args)
        self.assertNotIn("funnel", proxy_args)
        self.assertEqual(proxy.terminate.call_count, 1)
        self.assertEqual(web.terminate.call_count, 1)

    def test_existing_8443_is_reused_and_never_removed(self):
        old = launch.capture
        def configured(*args):
            if args[:3] == ("tailscale", "serve", "status"):
                import json
                return json.dumps(config_443_and_8443())
            return self.capture(*args)
        with patch.object(launch, "capture", side_effect=configured):
            web = MagicMock()
            web.poll.return_value = None
            launch.subprocess.Popen.return_value = web
            self.assertEqual(launch.run(), 0)
            self.assertEqual(launch.subprocess.Popen.call_count, 1)
            self.assertEqual(web.terminate.call_count, 1)

    def test_https_failure_cleans_up_only_owned_processes(self):
        web, proxy = MagicMock(), MagicMock()
        web.poll.return_value = None
        proxy.poll.return_value = None
        launch.subprocess.Popen.side_effect = [web, proxy]
        with patch.object(launch, "wait_until_healthy", side_effect=[
            None, launch.LaunchBlocked("HTTPS unavailable"),
        ]):
            self.assertEqual(launch.run(), 1)
        web.terminate.assert_called_once()
        proxy.terminate.assert_called_once()

    def test_foreground_route_is_reused_without_starting_new_serve(self):
        import json
        self.serve_snapshots = [foreground_8443(), foreground_8443(), foreground_8443()]
        web = MagicMock()
        web.poll.return_value = None
        launch.subprocess.Popen.return_value = web
        self.assertEqual(launch.run(), 0)
        self.assertEqual(launch.subprocess.Popen.call_count, 1)
        web.terminate.assert_called_once()

    def test_route_claimed_during_build_blocks_before_serve_spawn(self):
        self.serve_snapshots = [{}, foreground_8443("other", port=9999)]
        web = MagicMock()
        web.poll.return_value = None
        launch.subprocess.Popen.return_value = web
        self.assertEqual(launch.run(), 1)
        self.assertEqual(launch.subprocess.Popen.call_count, 1)
        web.terminate.assert_called_once()

    def test_route_claimed_before_spawn_even_when_same_destination_blocks(self):
        self.serve_snapshots = [{}, foreground_8443("other")]
        web = MagicMock()
        web.poll.return_value = None
        launch.subprocess.Popen.return_value = web
        self.assertEqual(launch.run(), 1)
        self.assertEqual(launch.subprocess.Popen.call_count, 1)
        web.terminate.assert_called_once()

    def test_collision_after_spawn_detects_duplicate_8443_sessions(self):
        duplicate = foreground_8443("launcher")
        duplicate["Foreground"]["other"] = foreground_8443("other")["Foreground"]["other"]
        self.serve_snapshots = [{}, {}, duplicate]
        web, proxy = MagicMock(), MagicMock()
        web.poll.return_value = None
        proxy.poll.return_value = None
        launch.subprocess.Popen.side_effect = [web, proxy]
        self.assertEqual(launch.run(), 1)
        self.assertEqual(launch.subprocess.Popen.call_count, 2)
        proxy.terminate.assert_called_once()
        web.terminate.assert_called_once()

    def test_conflicting_8443_prevents_any_process_or_config_change(self):
        original = config_443_and_8443()
        original["Web"][HOST + ":8443"]["Handlers"]["/"]["Proxy"] = "http://127.0.0.1:9999"
        import json
        def configured(*args):
            if args[:3] == ("tailscale", "serve", "status"):
                return json.dumps(original)
            return self.capture(*args)
        with patch.object(launch, "capture", side_effect=configured):
            self.assertEqual(launch.run(), 1)
        launch.subprocess.Popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
