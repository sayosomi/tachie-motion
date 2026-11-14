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
_stage_fds: dict[Path, int] = {}


def recovery_directories(folder: Path) -> tuple[Path, ...]:
    return tuple(sorted(item for item in folder.iterdir()
                        if item.name.startswith(RECOVERY_PREFIX)))


def require_batch_recovery_clear(folder: Path) -> None:
    existing = recovery_directories(folder)
    if existing:
        raise RuntimeError("Interrupted batch needs recovery; inspect: " +
                           ", ".join(map(str, existing)))


def _known_stage_contents(stage: Path) -> bool:
    """Never delete unrecognized user files from a stale-looking directory."""
    for entry in stage.iterdir():
        if entry.is_symlink():
            return False
        if entry.name == STAGE_MARKER:
            if not entry.is_file():
                return False
        elif entry.suffix.lower() in (".mov", ".otio"):
            if not entry.is_file():
                return False
        elif entry.name.startswith((".tachie-preset-", ".tachie-timeline-")):
            if not entry.is_dir():
                return False
        else:
            return False
    return True


def _reap_orphaned_stages(folder: Path) -> None:
    """Remove only our signed, unlocked orphan staging directories.

    A live batch in another server process holds the flock until it exits.
    Legacy or unknown directories are left untouched for manual inspection.
    Recovery directories are never eligible for this cleanup.
    """
    if fcntl is None:
        return
    for stage in folder.iterdir():
        if (not stage.name.startswith(STAGE_PREFIX) or stage.is_symlink()
                or not stage.is_dir() or stage in _stage_fds):
            continue
        marker = stage / STAGE_MARKER
        try:
            fd = os.open(marker, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except (FileNotFoundError, PermissionError, OSError):
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
            if _known_stage_contents(stage):
                shutil.rmtree(stage)
        finally:
            os.close(fd)


def create_stage(folder: Path) -> Path:
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
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        st = os.fstat(fd)
        actual = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
        if not stat.S_ISREG(st.st_mode) or actual != expected:
            raise FileExistsError("File changed before durability sync: " + path.name)
        os.fsync(fd)
        if _identity(path) != expected:
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
                        if _identity(quarantine) != expected_stage[sources[i].name]:
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
