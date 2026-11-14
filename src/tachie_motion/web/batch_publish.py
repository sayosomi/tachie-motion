"""Transactional publication for a complete batch of MOVs plus one OTIO.

Stage and validate *all* media before touching any public destination. Before
the first publication, hardlink all originals into a durable, named recovery
directory and fsync the manifest. A normal exception restores every original;
a process crash leaves the originals and manifest for manual recovery.

Do not auto-delete an incomplete recovery directory or overwrite foreign
writers. Multiple distinct public pathnames cannot be atomically changed by
portable filesystem APIs, so interrupted publication is explicitly recoverable,
not instantaneously atomic to concurrent file readers.
"""
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile

try:
    import fcntl  # POSIX flock: live batches keep their stage from being swept.
except ImportError:  # Platforms without flock do not auto-collect orphan stages.
    fcntl = None

from tachie_motion.web.solo_output import _identity, published_media_identity

RECOVERY_PREFIX = ".tachie-batch-recovery-"
STAGE_PREFIX = ".tachie-batch-stage-"
STAGE_MARKER = ".tachie-stage-owner"
STAGE_SIGNATURE = b"tachie-motion-batch-stage-v1\n"
STAGE_ALLOWLIST = ".tachie-stage-artifacts.json"
_STAGE_MANIFEST_FORMAT = "tachie-batch-stage-artifacts-v1"
_STAGE_MANIFEST_LIMIT = 1_048_576
_stage_fds: dict[Path, int] = {}


def recovery_directories(folder: Path) -> tuple[Path, ...]:
    return tuple(sorted(item for item in folder.iterdir()
                        if item.name.startswith(RECOVERY_PREFIX)))


def require_batch_recovery_clear(folder: Path) -> None:
    existing = recovery_directories(folder)
    if existing:
        raise RuntimeError("Interrupted batch needs recovery; inspect: " +
                           ", ".join(map(str, existing)))


def _stage_artifact_names(names: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    """An explicit set of flat output names; extensions alone confer no ownership."""
    if len(names) > 2001 or len(set(names)) != len(names):
        raise ValueError("Invalid batch-stage artifact list")
    for name in names:
        if (not isinstance(name, str) or not name or name in (".", "..")
                or "/" in name or chr(92) in name or chr(0) in name
                or name in (STAGE_MARKER, STAGE_ALLOWLIST)
                or Path(name).name != name
                or Path(name).suffix.lower() not in (".mov", ".otio")):
            raise ValueError("Unsafe batch-stage artifact name")
    return tuple(sorted(names))


def _write_stage_allowlist(stage: Path, names: tuple[str, ...]) -> None:
    """Persist planned artifact names before a render can create any of them."""
    with (stage / STAGE_ALLOWLIST).open("x", encoding="utf-8") as out:
        json.dump({"format": _STAGE_MANIFEST_FORMAT, "outputs": list(names)},
                  out, ensure_ascii=False, separators=(",", ":"))
        out.flush()
        os.fsync(out.fileno())


def _read_stage_allowlist(stage_fd: int) -> tuple[str, ...] | None:
    """Read without following links or blocking on a substituted FIFO."""
    try:
        fd = os.open(STAGE_ALLOWLIST, os.O_RDONLY |
                     getattr(os, "O_NONBLOCK", 0) |
                     getattr(os, "O_NOFOLLOW", 0), dir_fd=stage_fd)
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > _STAGE_MANIFEST_LIMIT:
            return None
        raw = os.read(fd, _STAGE_MANIFEST_LIMIT + 1)
        if len(raw) != st.st_size:
            return None
        obj = json.loads(raw)
        if not isinstance(obj, dict) or obj.get("format") != _STAGE_MANIFEST_FORMAT:
            return None
        values = obj.get("outputs")
        if not isinstance(values, list):
            return None
        names = _stage_artifact_names(values)
        if list(names) != values:
            return None
        return names
    except (OSError, ValueError, TypeError, UnicodeDecodeError):
        return None
    finally:
        os.close(fd)


def _known_stage_contents(stage_fd: int, allowed: tuple[str, ...]) -> bool:
    """Fail closed on unknown names, nested directories or nonregular inodes."""
    try:
        entries = set(os.listdir(stage_fd))
        if not {STAGE_MARKER, STAGE_ALLOWLIST}.issubset(entries):
            return False
        if not entries.issubset({STAGE_MARKER, STAGE_ALLOWLIST, *allowed}):
            return False
        for name in entries:
            st = os.stat(name, dir_fd=stage_fd, follow_symlinks=False)
            if not stat.S_ISREG(st.st_mode):
                return False
    except OSError:
        return False
    return True


def _reap_orphaned_stages(folder: Path) -> None:
    """Only unlink manifest-owned files in a signed, unlocked orphan stage.

    Never recursively delete a stage: an unknown file could be added after the
    inventory scan, and rmtree would then delete that unrelated data too.
    Older stages without the explicit index are retained for manual inspection.
    """
    if fcntl is None:
        return
    for stage in folder.iterdir():
        if (not stage.name.startswith(STAGE_PREFIX) or stage.is_symlink()
                or not stage.is_dir() or stage in _stage_fds):
            continue
        try:
            stage_fd = os.open(stage, os.O_RDONLY |
                               getattr(os, "O_DIRECTORY", 0) |
                               getattr(os, "O_NOFOLLOW", 0) |
                               getattr(os, "O_NONBLOCK", 0))
        except OSError:
            continue
        try:
            # A directory replacement between iterdir and open is not trusted.
            fd_stat = os.fstat(stage_fd)
            path_stat = os.lstat(stage)
            if (not stat.S_ISDIR(fd_stat.st_mode) or
                    (fd_stat.st_dev, fd_stat.st_ino) !=
                    (path_stat.st_dev, path_stat.st_ino)):
                continue
            try:
                fd = os.open(STAGE_MARKER, os.O_RDONLY |
                             getattr(os, "O_NOFOLLOW", 0) |
                             getattr(os, "O_NONBLOCK", 0), dir_fd=stage_fd)
            except OSError:
                continue
            try:
                data = os.fstat(fd)
                if not stat.S_ISREG(data.st_mode) or data.st_size != len(STAGE_SIGNATURE):
                    continue
                if os.read(fd, len(STAGE_SIGNATURE)) != STAGE_SIGNATURE:
                    continue
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except (BlockingIOError, OSError):
                    continue
                allowed = _read_stage_allowlist(stage_fd)
                if allowed is None or not _known_stage_contents(stage_fd, allowed):
                    continue
                # Delete only the explicitly registered, regular output names.
                # Recheck on every iteration so a newly inserted unknown name
                # stops cleanup; never pass the directory to shutil.rmtree.
                for name in allowed:
                    if not _known_stage_contents(stage_fd, allowed):
                        break
                    try:
                        item = os.stat(name, dir_fd=stage_fd, follow_symlinks=False)
                    except FileNotFoundError:
                        continue  # Partial renders need not have every output.
                    if not stat.S_ISREG(item.st_mode):
                        break
                    os.unlink(name, dir_fd=stage_fd)
                else:
                    if _known_stage_contents(stage_fd, allowed):
                        # Remove the index first; keep the signed marker as a
                        # lockable ownership receipt until the last step.
                        os.unlink(STAGE_ALLOWLIST, dir_fd=stage_fd)
                        remaining = set(os.listdir(stage_fd))
                        if remaining == {STAGE_MARKER}:
                            os.unlink(STAGE_MARKER, dir_fd=stage_fd)
                            try:
                                os.rmdir(stage)
                            except OSError:
                                # Unknown late additions remain, never reaped
                                # just because an extension happens to match.
                                pass
            finally:
                os.close(fd)
        except OSError:
            # A suspect or externally changed stage must not block a new batch.
            continue
        finally:
            os.close(stage_fd)


def create_stage(folder: Path, *, allowed_files: list[str] | tuple[str, ...] = ()) -> Path:
    allowed = _stage_artifact_names(allowed_files)
    require_batch_recovery_clear(folder)
    _reap_orphaned_stages(folder)
    stage = Path(tempfile.mkdtemp(prefix=STAGE_PREFIX, dir=folder))
    try:
        fd = os.open(stage / STAGE_MARKER, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        try:
            os.write(fd, STAGE_SIGNATURE)
            os.fsync(fd)
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            _stage_fds[stage] = fd
        except BaseException:
            os.close(fd)
            raise
        _write_stage_allowlist(stage, allowed)
        _fsync_directory(stage)
        _fsync_directory(folder)
        return stage
    except BaseException:
        discard_stage(stage)
        raise


def discard_stage(stage: Path) -> None:
    """Release the stage lease; never remove a recovery directory."""
    fd = _stage_fds.pop(stage, None)
    try:
        if stage.name.startswith(STAGE_PREFIX) and stage.is_dir() and not stage.is_symlink():
            shutil.rmtree(stage)
    finally:
        if fd is not None:
            os.close(fd)


def _fsync_directory(folder: Path) -> None:
    fd = os.open(folder, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _fsync_regular(path: Path, expected: tuple) -> None:
    """Durably sync the exact regular inode we approved; never follow symlinks."""
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) |
                 getattr(os, "O_NONBLOCK", 0))
    try:
        st = os.fstat(fd)
        actual = ((st.st_dev, st.st_ino, st.st_ctime_ns,
                   st.st_size, st.st_mtime_ns) if len(expected) == 5
                  else (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns))
        if not stat.S_ISREG(st.st_mode) or actual != expected:
            raise FileExistsError("File changed before durability sync: " + path.name)
        os.fsync(fd)
        now = published_media_identity(path) if len(expected) == 5 else _identity(path)
        if now != expected:
            raise FileExistsError("File changed during durability sync: " + path.name)
    finally:
        os.close(fd)


def _persist_manifest(folder: Path, recovery: Path, names: list[Path],
                      expected: dict[str, tuple | None]) -> None:
    manifest = {
        "format": "tachie-batch-recovery-v1",
        "output_dir": str(folder),
        "files": [
            {"name": target.name, "had_original": expected[target.name] is not None,
             "saved_as": "old-" + str(i)}
            for i, target in enumerate(names)
        ],
        "instructions": "Restore old-* files to the public paths before re-exporting; "
                        "new-* files are quarantined. Do not delete originals blindly.",
    }
    destination = recovery / "manifest.json"
    # Use an exclusive create. A partial manifest leaves this directory blocked.
    with destination.open("x", encoding="utf-8") as file:
        json.dump(manifest, file, ensure_ascii=False, indent=2)
        file.flush()
        os.fsync(file.fileno())
    _fsync_directory(recovery)
    _fsync_directory(folder)


def publish_batch(
    *, folder: Path, stage: Path, movie_names: list[str],
    timeline_name: str, original: dict[str, tuple | None],
    expected_stage: dict[str, tuple],
) -> str | None:
    """Publish all names or restore the previous set on ordinary exceptions.

    All files in stage have their *final* basenames already. The supplied
    original identities were captured at batch start. We compare again before
    any public mutation and after obtaining each original hardlink.
    """
    if not stage.is_dir() or stage.is_symlink() or stage.parent != folder:
        raise ValueError("Batch stage folder is unsafe")
    if not stage.name.startswith(STAGE_PREFIX):
        raise ValueError("Not an owned batch staging directory")
    require_batch_recovery_clear(folder)
    names = [name + ".mov" for name in movie_names] + [timeline_name + ".otio"]
    if len(names) != len(set(names)):
        raise ValueError("Duplicate batch publication targets")
    targets = [folder / name for name in names]
    sources = [stage / name for name in names]
    if set(original) != set(names) or set(expected_stage) != set(names):
        raise ValueError("Batch publication manifest differs from staging")
    for target, source in zip(targets, sources):
        if _identity(target) != original[target.name]:
            raise FileExistsError("Output changed before publishing: " + target.name)
        if source.is_symlink() or published_media_identity(source) != expected_stage[source.name]:
            raise ValueError("Staged output changed: " + source.name)

    # File content must be durable before its old public pathname is moved.
    # Directory fsync alone cannot flush the MOV / OTIO media data.
    for source in sources:
        _fsync_regular(source, expected_stage[source.name])
    _fsync_directory(stage)
    recovery = Path(tempfile.mkdtemp(prefix=RECOVERY_PREFIX, dir=folder))
    mutated: set[int] = set()
    preserve_recovery = False
    try:
        # Hardlinks preserve original data across rename, hard crash and
        # rollback, without temporarily duplicating large ProRes MOV bytes.
        for i, target in enumerate(targets):
            if original[target.name] is not None:
                saved = recovery / ("old-" + str(i))
                os.link(target, saved)
                try:
                    approved_backup = (_identity(saved) == original[target.name] and
                                       _identity(target) == original[target.name])
                except ValueError:
                    approved_backup = False
                if not approved_backup:
                    # The just-created hardlink may contain a third-party
                    # replacement (including a symlink). Preserve it.
                    preserve_recovery = True
                    raise FileExistsError("Output changed while backing up: " + target.name)
                _fsync_regular(saved, original[target.name])
        _fsync_directory(stage)
        _persist_manifest(folder, recovery, targets, original)
        # The manifest and all original hardlinks exist before any rename.
        for i, (target, source) in enumerate(zip(targets, sources)):
            old = original[target.name]
            if _identity(target) != old:
                raise FileExistsError("Output changed during batch publication: " + target.name)
            if source.is_symlink() or published_media_identity(source) != expected_stage[source.name]:
                raise ValueError("Staged output changed during publication")
            if old is not None:
                os.rename(target, recovery / ("moved-" + str(i)))
                mutated.add(i)
                try:
                    matches = _identity(recovery / ("moved-" + str(i))) == old
                except ValueError:
                    matches = False
                if not matches:
                    preserve_recovery = True
                    raise FileExistsError("External destination change; recovery required")
            # Never overwrite an unknown file another process has placed here.
            os.link(source, target)
            mutated.add(i)
        _fsync_directory(recovery)
        _fsync_directory(folder)
    except BaseException as failure:
        try:
            for i in reversed(range(len(targets))):
                target = targets[i]
                old = original[target.name]
                if i in mutated:
                    current = _identity(target)
                    if current is not None:
                        quarantine = recovery / ("new-" + str(i))
                        os.rename(target, quarantine)
                        staged_identity = expected_stage[sources[i].name]
                        # Hardlink creation changes ctime; compare only the
                        # durable inode/content fields during rollback.
                        expected_moved = (staged_identity[0], staged_identity[1],
                                          staged_identity[3], staged_identity[4])
                        if _identity(quarantine) != expected_moved:
                            # A different writer occupied the public path.
                            # Preserve that inode in quarantine, then attempt
                            # to restore the approved old inode separately.
                            preserve_recovery = True
                    saved = recovery / ("old-" + str(i))
                    if old is not None:
                        if not saved.is_file() or saved.is_symlink():
                            raise RuntimeError("Missing original recovery copy")
                        if _identity(saved) != old:
                            preserve_recovery = True
                            raise RuntimeError("Original recovery copy was replaced")
                        os.link(saved, target)
                if _identity(target) != old:
                    raise RuntimeError("Rollback identity mismatch")
            _fsync_directory(folder)
            _fsync_directory(recovery)
        except BaseException as restore_error:
            raise RuntimeError("Batch recovery required: " + str(recovery)) from restore_error
        if preserve_recovery:
            # Rollback of *our* files may have succeeded, but a foreign
            # moved-/new-/old- inode must never be deleted by rmtree.
            raise RuntimeError("Batch recovery required (external writer preserved): "
                               + str(recovery)) from failure
        try:
            shutil.rmtree(recovery)
        except OSError as error:
            raise RuntimeError("Batch rolled back, cleanup required: " + str(recovery)) from error
        raise
    # All media data and original backups were synced before this cleanup.
    try:
        shutil.rmtree(recovery)
    except OSError:
        return "Batch saved; recovery backup cleanup required: " + str(recovery)
    return None
