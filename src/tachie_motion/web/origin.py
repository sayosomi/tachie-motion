"""Validate an explicit Tailscale Serve origin; default remains loopback-only."""

import os
from urllib.parse import urlsplit


ENV_NAME = "TACHIE_TAILSCALE_ORIGIN"


def configured_tailscale_origin() -> str | None:
    """Return a canonical tailnet HTTPS origin or refuse unsafe configuration."""
    raw = os.environ.get(ENV_NAME, "")
    if not raw:
        return None
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname
        if not (
            parsed.scheme == "https"
            and host is not None
            and host.endswith(".ts.net")
            and host != ".ts.net"
            and parsed.port == 8443
            and parsed.username is None
            and parsed.password is None
            and parsed.path == ""
            and not parsed.query
            and not parsed.fragment
            and raw == f"https://{host}:8443"
        ):
            raise ValueError("Expected a canonical Tailscale Serve HTTPS origin on port 8443")
    except ValueError as exc:
        raise ValueError(
            f"{ENV_NAME} must be https://<machine>.<tailnet>.ts.net:8443 (no path)"
        ) from exc
    return raw
