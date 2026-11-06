"""Launch current Mac Web UI + isolated local-only Finder picker on demand.

No Tailscale changes, background daemons, source media writes or git checkout.
Owned subprocesses are stopped on exit; pre-existing port occupants are untouched.
"""

import json
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
WEB_PORT = 8765
PICKER_PORT = 8766


def require_free(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        try:
            listener.bind(("127.0.0.1", port))
        except OSError as exc:
            raise RuntimeError(
                f"127.0.0.1:{port} is already in use; stop the existing server first"
            ) from exc


def healthy(url: str, *, picker: bool) -> bool:
    headers = {"Origin": "http://127.0.0.1:8765"} if picker else {}
    try:
        with urlopen(Request(url, headers=headers), timeout=2) as response:
            obj = json.load(response)
            return response.status == 200 and (
                obj.get("ready") is True if picker else obj.get("ok") is True
            )
    except (OSError, ValueError, TimeoutError):
        return False


def stop_owned(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main() -> int:
    if sys.platform != "darwin":
        print("BLOCKED: Mac Finder launcher requires macOS", flush=True)
        return 1
    web = picker = None
    try:
        require_free(WEB_PORT)
        require_free(PICKER_PORT)
        if not (ROOT / "frontend" / "node_modules").is_dir():
            raise RuntimeError("frontend/node_modules missing; run npm --prefix frontend install")
        subprocess.run(["npm", "--prefix", "frontend", "run", "build"],
                       cwd=ROOT, check=True, timeout=180)
        web = subprocess.Popen([sys.executable, "-m", "tachie_motion.web.cli",
                                "--port", str(WEB_PORT)], cwd=ROOT)
        picker = subprocess.Popen([sys.executable, "-m",
                                   "tachie_motion.web.picker_cli"], cwd=ROOT)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if any(p.poll() is not None for p in (web, picker)):
                raise RuntimeError("One of the local servers terminated early")
            if healthy(f"http://127.0.0.1:{WEB_PORT}/api/health", picker=False) and healthy(
                f"http://127.0.0.1:{PICKER_PORT}/health", picker=True
            ):
                print(f"MAC_READY: http://127.0.0.1:{WEB_PORT}/", flush=True)
                print("Finder picker ready (127.0.0.1:8766 only); Ctrl+C to stop", flush=True)
                while all(p.poll() is None for p in (web, picker)):
                    time.sleep(0.25)
                raise RuntimeError("One of the servers exited")
            time.sleep(0.2)
        raise RuntimeError("Local Web or Finder picker health check timed out")
    except KeyboardInterrupt:
        return 0
    except (RuntimeError, OSError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired) as exc:
        print(f"BLOCKED: {exc}", flush=True)
        return 1
    finally:
        stop_owned(picker)
        stop_owned(web)


if __name__ == "__main__":
    raise SystemExit(main())
