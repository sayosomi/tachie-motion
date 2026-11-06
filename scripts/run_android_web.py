"""Start tachie-motion locally and expose only its dedicated tailnet HTTPS port.

One foreground supervisor owns the web and (if necessary) Tailscale Serve
processes. Ctrl+C stops only processes started by this launcher. Never
reconfigures 443, starts Funnel, stashes, checks out, or changes user media.

Usage: .venv/bin/python scripts/run_android_web.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
from urllib.request import urlopen

REPO = Path(__file__).resolve().parents[1]
PORT = 8765
HTTPS_PORT = 8443
FQDN_PATTERN = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$")


class LaunchBlocked(RuntimeError):
    """An operational precondition or readiness check failed."""


def capture(*args: str) -> str:
    try:
        result = subprocess.run(
            list(args), text=True, capture_output=True, timeout=12, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise LaunchBlocked(f"Cannot run {args[0]}: {exc}") from exc
    if result.returncode:
        raise LaunchBlocked(
            f"{' '.join(args[:2])} failed: "
            + (result.stderr.strip() or result.stdout.strip() or str(result.returncode))
        )
    return result.stdout


def tailscale_hostname(status: dict) -> str:
    if status.get("BackendState") != "Running":
        raise LaunchBlocked("Tailscale is not connected (BackendState != Running)")
    name = status.get("Self", {}).get("DNSName", "").rstrip(".").lower()
    if not FQDN_PATTERN.fullmatch(name):
        raise LaunchBlocked("Tailscale did not provide a valid *.ts.net DNS name")
    return name


def serve_8443_state(config: dict | None, hostname: str) -> str:
    """Classify the entire Serve configuration, including every foreground session.

    Reuse only ONE exact 8443 handler. A conflicting or duplicate handler,
    mismatched host, unknown shape, or Funnel exposure fails closed. The
    function never changes an existing configuration.
    """
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise LaunchBlocked("Invalid Tailscale Serve status JSON")

    scopes: list[tuple[str, dict]] = [("background", config)]
    # A missing Foreground field is valid; an explicitly present JSON null,
    # list or boolean is not. Do not normalize malformed fields to empty maps.
    foreground = config.get("Foreground", {})
    if type(foreground) is not dict:
        raise LaunchBlocked("Invalid Foreground Serve configuration")
    for session, nested in foreground.items():
        if not isinstance(nested, dict):
            raise LaunchBlocked(f"Invalid Foreground Serve session: {session}")
        # The upstream ServeConfig contract forbids nested foreground blocks.
        # Test key *presence*: empty {}, [], false or null are still invalid.
        if "Foreground" in nested:
            raise LaunchBlocked("Unexpected nested Foreground Serve configuration")
        scopes.append((f"Foreground {session}", nested))

    expected_host = f"{hostname}:{HTTPS_PORT}"
    expected_handler = {"/": {"Proxy": f"http://127.0.0.1:{PORT}"}}
    found = []
    for scope, entry in scopes:
        tcp = entry.get("TCP", {})
        web = entry.get("Web", {})
        funnel = entry.get("AllowFunnel", {})
        if any(type(x) is not dict for x in (tcp, web, funnel)):
            raise LaunchBlocked(f"Invalid Serve configuration in {scope}")
        # Go map[HostPort]bool encodes strictly as JSON booleans, not 0/1
        # or string values. Validate the full scope, not just port 8443.
        if any(type(flag) is not bool for flag in funnel.values()):
            raise LaunchBlocked(f"Invalid AllowFunnel boolean in {scope}")

        port_key = str(HTTPS_PORT)
        web_keys = [key for key in web if str(key).endswith(f":{HTTPS_PORT}")]
        funnel_keys = [key for key in funnel if str(key).endswith(f":{HTTPS_PORT}")]
        if any(funnel[key] is True for key in funnel_keys):
            raise LaunchBlocked(f"8443 is configured for Funnel in {scope}")
        if port_key not in tcp and not web_keys and not funnel_keys:
            continue
        handler = tcp.get(port_key)
        exact_https = (
            type(handler) is dict
            and handler.keys() == {"HTTPS"}
            and handler.get("HTTPS") is True
        )
        if (
            not exact_https
            or web_keys != [expected_host]
            or not isinstance(web[expected_host], dict)
            or web[expected_host].get("Handlers") != expected_handler
            or any(key != expected_host for key in funnel_keys)
        ):
            raise LaunchBlocked(
                f"8443 already has a different Serve route in {scope}; no changes made"
            )
        found.append(scope)

    if len(found) > 1:
        raise LaunchBlocked("8443 is configured in multiple Serve sessions; refusing reuse")
    return "existing" if found else "absent"


def serve_status() -> dict | None:
    """Fetch the complete Serve config; never accept a partial or stale guess."""
    return json.loads(capture("tailscale", "serve", "status", "--json"))


def available_local_port() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", PORT))
        except OSError as exc:
            raise LaunchBlocked(
                f"127.0.0.1:{PORT} is already in use; existing process not terminated"
            ) from exc


def health_check(url: str) -> bool:
    try:
        with urlopen(url, timeout=2.5) as response:
            return response.status == 200 and json.load(response).get("ok") is True
    except (OSError, ValueError, KeyError, TimeoutError):
        return False


def wait_until_healthy(url: str, children: list[subprocess.Popen], limit: float) -> None:
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        for child in children:
            if child.poll() is not None:
                raise LaunchBlocked(f"Service process exited before READY: {child.args}")
        if health_check(url):
            return
        time.sleep(0.4)
    raise LaunchBlocked(f"Health check timed out: {url}")


def stop_owned(child: subprocess.Popen | None) -> None:
    if child is None or child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=5)


def run() -> int:
    server = None
    serve = None
    try:
        if not (REPO / ".venv" / "bin" / "python").is_file():
            raise LaunchBlocked("Missing .venv/bin/python")
        if not (REPO / "frontend" / "node_modules").is_dir():
            raise LaunchBlocked("Missing frontend/node_modules; run npm install once")
        available_local_port()
        hostname = tailscale_hostname(json.loads(capture("tailscale", "status", "--json")))
        current = serve_status()
        state = serve_8443_state(current, hostname)

        head = capture("git", "-C", str(REPO), "rev-parse", "HEAD").strip()
        print("CHECKOUT HEAD: " + head, flush=True)
        print("Building current checkout UI (not using stale frontend/dist)", flush=True)
        subprocess.run(["npm", "run", "build"], cwd=REPO / "frontend", check=True)

        env = dict(os.environ)
        env["TACHIE_TAILSCALE_ORIGIN"] = f"https://{hostname}:{HTTPS_PORT}"
        server = subprocess.Popen(
            [str(REPO / ".venv" / "bin" / "python"), "-m", "tachie_motion.web.cli"],
            cwd=REPO,
            env=env,
        )
        wait_until_healthy(f"http://127.0.0.1:{PORT}/api/health", [server], 20)

        # The UI build and local startup can take time. Do not act on an old
        # status snapshot; another foreground session might have claimed 8443.
        latest = serve_status()
        if latest != current:
            raise LaunchBlocked(
                "Tailscale Serve config changed during startup; "
                "no Serve changes made, retry after inspecting port 8443"
            )
        if serve_8443_state(latest, hostname) != state:
            raise LaunchBlocked("8443 changed before Serve startup; no changes made")

        if state == "absent":
            print("Starting isolated foreground Tailscale Serve 8443", flush=True)
            serve = subprocess.Popen([
                "tailscale", "serve", f"--https={HTTPS_PORT}",
                f"http://127.0.0.1:{PORT}",
            ])
        else:
            print("Reusing existing exact 8443 mapping (never modifying 443)", flush=True)

        android_url = f"https://{hostname}:{HTTPS_PORT}/"
        wait_until_healthy(android_url + "api/health", [x for x in (server, serve) if x], 30)
        # The CLI has now registered its foreground config (or we are reusing
        # an existing one). Detect duplicate sessions or unexpected routes
        # before claiming Android readiness; stop only our own child on error.
        if serve_8443_state(serve_status(), hostname) != "existing":
            raise LaunchBlocked("8443 configuration disappeared before READY")
        print("ANDROID_READY: " + android_url, flush=True)
        print("Ctrl+C: stop launcher-owned processes only", flush=True)

        while True:
            for child in (server, serve):
                if child and child.poll() is not None:
                    raise LaunchBlocked("A managed service exited; HTTPS is no longer ready")
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nStopping tachie-motion's session", flush=True)
        return 0
    except (LaunchBlocked, subprocess.CalledProcessError, ValueError) as exc:
        print("BLOCKED: " + str(exc), file=sys.stderr, flush=True)
        return 1
    finally:
        stop_owned(serve)
        stop_owned(server)


if __name__ == "__main__":
    raise SystemExit(run())
