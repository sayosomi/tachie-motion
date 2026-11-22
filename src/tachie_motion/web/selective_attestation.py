"""Authenticate selective reuse history using a private, per-user local HMAC key.

Without the original key (including on a different Mac), generated history
is advisory only and cannot authorize reuse. The secret is never in the OTIO,
output folder, project JSON, or repository.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import stat
from typing import Any

AUTH_KEY = "tachie_motion_auth"
_FORMAT = "tachie-motion-local-hmac-v1"
_KEY_LENGTH = 32


def _key_path() -> Path:
    return Path.home() / ".tachie-motion" / "reuse-history-v1.key"


def _private_dir(path: Path, *, create: bool) -> bool:
    try:
        if create:
            path.mkdir(mode=0o700, exist_ok=True)
        st = path.lstat()
    except FileNotFoundError:
        return False
    if (not stat.S_ISDIR(st.st_mode) or st.st_mode & 0o077 or
            (hasattr(os, "getuid") and st.st_uid != os.getuid())):
        raise ValueError("Unsafe local history key directory")
    return True


def _load_key(*, create: bool) -> bytes | None:
    path = _key_path()
    if not _private_dir(path.parent, create=create):
        return None
    if create:
        # One immutable-on-creation key, even with concurrent export workers.
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY |
                         getattr(os, "O_NOFOLLOW", 0), 0o600)
        except FileExistsError:
            pass
        else:
            try:
                key = secrets.token_bytes(_KEY_LENGTH)
                if os.write(fd, key) != len(key):
                    raise OSError("Short local key write")
                os.fsync(fd)
            finally:
                os.close(fd)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return None
    try:
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077 or
                (hasattr(os, "getuid") and st.st_uid != os.getuid())):
            raise ValueError("Unsafe local history key file")
        key = os.read(fd, _KEY_LENGTH + 1)
        if len(key) != _KEY_LENGTH:
            raise ValueError("Invalid local history key")
        # Fail closed for replacement and symlink paths.
        path_stat = path.lstat()
        if (path_stat.st_dev, path_stat.st_ino) != (st.st_dev, st.st_ino):
            raise ValueError("Local history key changed while reading")
        return key
    finally:
        os.close(fd)


def _unsigned(doc: dict[str, Any]) -> dict[str, Any]:
    metadata = doc.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError("Invalid timeline metadata")
    copy = dict(doc)
    copy["metadata"] = {k: v for k, v in metadata.items() if k != AUTH_KEY}
    return copy


def _digest(key: bytes, doc: dict[str, Any]) -> str:
    data = json.dumps(_unsigned(doc), sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def sign_timeline(doc: dict[str, Any]) -> None:
    """Sign final public-path references and the entire history together."""
    if AUTH_KEY in doc.get("metadata", {}):
        raise ValueError("Timeline authentication record already exists")
    key = _load_key(create=True)
    if key is None:
        raise ValueError("Unable to initialize local history authentication")
    doc["metadata"][AUTH_KEY] = {"format": _FORMAT, "hmac_sha256": _digest(key, doc)}


def authenticated_timeline(doc: Any) -> bool:
    """Unsigned, legacy, re-signed elsewhere, tampered => no reuse."""
    try:
        if not isinstance(doc, dict):
            return False
        auth = doc["metadata"].get(AUTH_KEY)
        if (not isinstance(auth, dict) or set(auth) != {"format", "hmac_sha256"} or
                auth["format"] != _FORMAT or type(auth["hmac_sha256"]) is not str or
                len(auth["hmac_sha256"]) != 64):
            return False
        key = _load_key(create=False)
        return key is not None and hmac.compare_digest(
            auth["hmac_sha256"], _digest(key, doc))
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return False
