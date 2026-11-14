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

from tachie_motion.web.solo_output import _identity, published_media_identity

RECOVERY_PREFIX = ".tachie-batch-recovery-"
STAGE_PREFIX = ".tachie-batch-stage-"


def recovery_directories(folder: Path) -> tuple[Path, ...]:
    return tuple(sorted(item for item in folder.iterdir()
                        if item.name.startswith(RECOVERY_PREFIX)))


def require_batch_recovery_clear(folder: Path) -> None:
    existing = recovery_directories(folder)
    if existing:
        raise RuntimeError("Interrupted batch needs recovery; inspect: " +
                           ", ".join(map(str, existing)))


def create_stage(folder: Path) -> Path:
    require_batch_recovery_clear(folder)
    return Path(tempfile.mkdtemp(prefix=STAGE_PREFIX, dir=folder))


def discard_stage(stage: Path) -> None:
    """Only remove our staging area, never originals or a recovery directory."""
    if stage.name.startswith(STAGE_PREFIX) and stage.is_dir() and not stage.is_symlink():
        shutil.rmtree(stage)


def _fsync_directory(folder: Path) -> None:
    fd = os.open(folder, os.O_RDONLY)
    try:
        os.fsync(fd)
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

    recovery = Path(tempfile.mkdtemp(prefix=RECOVERY_PREFIX, dir=folder))
    mutations_started = False
    try:
        # Hardlinks preserve original data across rename, hard crash and
        # rollback, without temporarily duplicating large ProRes MOV bytes.
        for i, target in enumerate(targets):
            if original[target.name] is not None:
                os.link(target, recovery / ("old-" + str(i)))
                if _identity(target) != original[target.name]:
                    raise FileExistsError("Output changed while backing up: " + target.name)
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
                mutations_started = True
                if _identity(recovery / ("moved-" + str(i))) != old:
                    raise FileExistsError("External destination change; recovery required")
            # Never overwrite an unknown file another process has placed here.
            os.link(source, target)
            mutations_started = True
        _fsync_directory(folder)
    except BaseException:
        try:
            if mutations_started:
                # Never unlink other processes' files. Quarantine the new
                # pathname and verify its inode before restoring each old one.
                for i in reversed(range(len(targets))):
                    target = targets[i]
                    current = _identity(target)
                    if current is not None:
                        quarantine = recovery / ("new-" + str(i))
                        os.rename(target, quarantine)
                        source_stat = _identity(sources[i])
                        if _identity(quarantine) != source_stat:
                            raise RuntimeError("External writer detected; manual recovery required")
                    saved = recovery / ("old-" + str(i))
                    if original[target.name] is not None:
                        if not saved.is_file() or saved.is_symlink():
                            raise RuntimeError("Missing original recovery copy")
                        os.link(saved, target)
                    if _identity(target) != original[target.name]:
                        raise RuntimeError("Rollback identity mismatch")
                _fsync_directory(folder)
            else:
                # No public path changed; originals are still in place.
                for target in targets:
                    if _identity(target) != original[target.name]:
                        raise RuntimeError("External writer detected before commit")
        except BaseException as restore_error:
            raise RuntimeError("Batch recovery required: " + str(recovery)) from restore_error
        # Restored successfully: do not leave a stale lock.
        try:
            shutil.rmtree(recovery)
        except OSError as error:
            raise RuntimeError("Batch rolled back, cleanup required: " + str(recovery)) from error
        raise

    try:
        shutil.rmtree(recovery)
    except OSError:
        return "Batch saved; recovery backup cleanup required: " + str(recovery)
    return None
