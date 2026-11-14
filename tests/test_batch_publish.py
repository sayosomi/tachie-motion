"""Batch publication: rollback, collision, crash recovery and NFD names."""
import os
import stat
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tachie_motion.web import batch_publish
from tachie_motion.web.batch_publish import (
    RECOVERY_PREFIX, STAGE_PREFIX, STAGE_MARKER, STAGE_SIGNATURE, STAGE_ALLOWLIST,
    create_stage, discard_stage, publish_batch, recovery_directories,
    require_batch_recovery_clear,
)
from tachie_motion.web.solo_output import _identity, published_media_identity, single_destination


class BatchPublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.mov_names = ["001_あんこもん_e\u0301", "002_あんこもん_次"]
        self.otio = "作品"
        self.names = [name + ".mov" for name in self.mov_names] + [self.otio + ".otio"]
        self.stage = create_stage(self.folder)

    def manifest(self, existing: bool = True):
        originals = {}
        staged = {}
        for i, name in enumerate(self.names):
            target = self.folder / name
            source = self.stage / name
            if existing:
                target.write_bytes(("OLD-%s-" % i).encode())
            source.write_bytes(("NEW-%s-" % i).encode())
            originals[name] = _identity(target)
            staged[name] = published_media_identity(source)
        return originals, staged

    def publish(self, originals, staged):
        return publish_batch(
            folder=self.folder, stage=self.stage,
            movie_names=self.mov_names, timeline_name=self.otio,
            original=originals, expected_stage=staged,
        )

    def assert_old(self):
        for i, name in enumerate(self.names):
            self.assertEqual((self.folder / name).read_bytes(),
                             ("OLD-%s-" % i).encode())

    def assert_new(self):
        for i, name in enumerate(self.names):
            self.assertEqual((self.folder / name).read_bytes(),
                             ("NEW-%s-" % i).encode())

    def test_complete_overwrite_replaces_movs_and_otio_after_staging(self):
        originals, staged = self.manifest()
        self.assert_old()
        self.assertIsNone(self.publish(originals, staged))
        self.assert_new()
        self.assertEqual(recovery_directories(self.folder), ())
        self.assertEqual(len([p for p in self.folder.iterdir() if p.suffix == ".otio"]), 1)

    def test_new_batch_commit_keeps_only_expected_movs_and_otio(self):
        originals, staged = self.manifest(existing=False)
        self.assertIsNone(self.publish(originals, staged))
        self.assert_new()
        self.assertEqual(recovery_directories(self.folder), ())

    def test_second_mov_and_otio_publication_failures_restore_all_originals(self):
        originals, staged = self.manifest()
        raw_link = os.link
        for failure in (self.names[1], self.names[2]):
            with self.subTest(failure=failure):
                # Earlier attempted publication legitimately changes the
                # staged inode ctime when hardlinks are created/removed.
                staged = {name: published_media_identity(self.stage / name)
                          for name in self.names}
                def link(src, dst):
                    if Path(dst) == self.folder / failure and Path(src).parent == self.stage:
                        raise OSError("injected failure during commit")
                    return raw_link(src, dst)
                with patch("tachie_motion.web.batch_publish.os.link", side_effect=link):
                    with self.assertRaisesRegex(OSError, "injected failure"):
                        self.publish(originals, staged)
                self.assert_old()
                self.assertEqual(recovery_directories(self.folder), ())

    def test_stage_generation_failure_does_not_mutate_existing_files(self):
        self.manifest()
        (self.stage / self.names[1]).unlink()
        discard_stage(self.stage)
        self.assert_old()
        self.assertFalse(self.stage.exists())
        self.assertEqual(recovery_directories(self.folder), ())

    def test_external_change_before_commit_preserves_foreign_content(self):
        originals, staged = self.manifest()
        foreign = self.folder / self.names[1]
        foreign.write_bytes(b"EXTERNALLY CHANGED")
        with self.assertRaisesRegex(FileExistsError, "changed"):
            self.publish(originals, staged)
        self.assertEqual(foreign.read_bytes(), b"EXTERNALLY CHANGED")
        self.assertEqual(recovery_directories(self.folder), ())

    def test_symlink_destination_is_rejected_before_original_mutation(self):
        originals, staged = self.manifest()
        target = self.folder / self.names[1]
        target.unlink()
        target.symlink_to(self.folder / self.names[0])
        with self.assertRaises(ValueError):
            self.publish(originals, staged)
        self.assertEqual((self.folder / self.names[0]).read_bytes(), b"OLD-0-")
        self.assertEqual(recovery_directories(self.folder), ())

    def test_interrupted_rollback_keeps_originals_in_recovery(self):
        originals, staged = self.manifest()
        raw_link = os.link
        def link(src, dst):
            if (Path(src).parent == self.stage and
                    Path(dst) == self.folder / self.names[1]):
                raise OSError("fail MOV2 publish")
            if (Path(src).name == "old-0" and
                    Path(dst) == self.folder / self.names[0]):
                raise OSError("fail restoring MOV1")
            return raw_link(src, dst)
        with patch("tachie_motion.web.batch_publish.os.link", side_effect=link):
            with self.assertRaisesRegex(RuntimeError, "recovery required"):
                self.publish(originals, staged)
        locations = recovery_directories(self.folder)
        self.assertEqual(len(locations), 1)
        backup = locations[0]
        self.assertTrue((backup / "manifest.json").is_file())
        for i in range(len(self.names)):
            self.assertEqual((backup / ("old-" + str(i))).read_bytes(),
                             ("OLD-%s-" % i).encode())
        with self.assertRaisesRegex(RuntimeError, "recovery"):
            require_batch_recovery_clear(self.folder)
        self.assertEqual(single_destination(self.folder / "other.mov")["state"],
                         "recovery_required")

    def test_external_replacement_at_rename_is_quarantined_not_deleted(self):
        originals, staged = self.manifest()
        target = self.folder / self.names[0]
        raw_rename = os.rename
        exchanged = False
        def swap_before_move(src, dst):
            nonlocal exchanged
            if not exchanged and Path(src) == target and Path(dst).name == "moved-0":
                exchanged = True
                outsider = self.folder / "third_party.mov"
                outsider.write_bytes(b"FOREIGN-MOV-MUST-SURVIVE")
                os.replace(outsider, target)
            return raw_rename(src, dst)
        with patch("tachie_motion.web.batch_publish.os.rename", side_effect=swap_before_move):
            with self.assertRaisesRegex(RuntimeError, "external writer preserved"):
                self.publish(originals, staged)
        self.assertTrue(exchanged)
        self.assert_old()
        folders = recovery_directories(self.folder)
        self.assertEqual(len(folders), 1)
        self.assertEqual((folders[0] / "moved-0").read_bytes(), b"FOREIGN-MOV-MUST-SURVIVE")
        self.assertEqual((folders[0] / "old-0").read_bytes(), b"OLD-0-")
        with self.assertRaisesRegex(RuntimeError, "recovery"):
            require_batch_recovery_clear(self.folder)

    def test_external_file_after_move_is_quarantined_not_deleted(self):
        originals, staged = self.manifest()
        target = self.folder / self.names[0]
        raw_link = os.link
        inserted = False
        def race_before_publish(src, dst):
            nonlocal inserted
            if not inserted and Path(src).parent == self.stage and Path(dst) == target:
                inserted = True
                target.write_bytes(b"THIRD-PARTY-NEW-OUTPUT")
            return raw_link(src, dst)
        with patch("tachie_motion.web.batch_publish.os.link", side_effect=race_before_publish):
            with self.assertRaisesRegex(RuntimeError, "external writer preserved"):
                self.publish(originals, staged)
        self.assertTrue(inserted)
        self.assert_old()
        folders = recovery_directories(self.folder)
        self.assertEqual(len(folders), 1)
        self.assertEqual((folders[0] / "new-0").read_bytes(), b"THIRD-PARTY-NEW-OUTPUT")

    def test_external_file_during_backup_remains_in_recovery(self):
        originals, staged = self.manifest()
        target = self.folder / self.names[0]
        raw_link = os.link
        inserted = False
        def race_before_backup(src, dst):
            nonlocal inserted
            if not inserted and Path(src) == target and Path(dst).name == "old-0":
                inserted = True
                outsider = self.folder / "third_party.mov"
                outsider.write_bytes(b"FOREIGN-BACKUP")
                os.replace(outsider, target)
            return raw_link(src, dst)
        with patch("tachie_motion.web.batch_publish.os.link", side_effect=race_before_backup):
            # The external process already replaced the original before our
            # backup began. Report manual recovery, never delete its inode.
            with self.assertRaisesRegex(RuntimeError, "Batch recovery required"):
                self.publish(originals, staged)
        folders = recovery_directories(self.folder)
        self.assertEqual(len(folders), 1)
        self.assertEqual(target.read_bytes(), b"FOREIGN-BACKUP")
        self.assertEqual((folders[0] / "old-0").read_bytes(), b"FOREIGN-BACKUP")

    def test_all_media_and_old_file_contents_synced_before_first_public_link(self):
        originals, staged = self.manifest()
        raw_sync, raw_link = os.fsync, os.link
        synced = set()
        expected = {(self.stage / name).stat().st_ino for name in self.names}
        expected.update((self.folder / name).stat().st_ino for name in self.names)
        def record_sync(fd):
            st = os.fstat(fd)
            if stat.S_ISREG(st.st_mode):
                synced.add(st.st_ino)
            return raw_sync(fd)
        def assert_durable_link(src, dst):
            if Path(src).parent == self.stage and Path(dst).parent == self.folder:
                self.assertTrue(expected.issubset(synced), "Media or old backups not fsynced")
            return raw_link(src, dst)
        with patch("tachie_motion.web.batch_publish.os.fsync", side_effect=record_sync):
            with patch("tachie_motion.web.batch_publish.os.link", side_effect=assert_durable_link):
                self.publish(originals, staged)
        self.assert_new()

    def test_stage_media_fsync_failure_leaves_old_generation_intact(self):
        originals, staged = self.manifest()
        raw_sync = os.fsync
        first_inode = (self.stage / self.names[0]).stat().st_ino
        def fail_media_sync(fd):
            if os.fstat(fd).st_ino == first_inode:
                raise OSError("injected staged MOV sync failure")
            return raw_sync(fd)
        with patch("tachie_motion.web.batch_publish.os.fsync", side_effect=fail_media_sync):
            with self.assertRaisesRegex(OSError, "staged MOV sync failure"):
                self.publish(originals, staged)
        self.assert_old()
        self.assertEqual(recovery_directories(self.folder), ())

    def abandon_stage(self, allowed_files: list[str]) -> Path:
        """Simulate process death without running discard_stage."""
        stage = create_stage(self.folder, allowed_files=allowed_files)
        os.close(batch_publish._stage_fds.pop(stage))
        return stage

    @unittest.skipUnless(batch_publish.fcntl is not None, "flock required")
    def test_restart_cleans_only_signed_indexed_unlocked_stages(self):
        unsigned = self.folder / (STAGE_PREFIX + "unsigned")
        unsigned.mkdir()
        (unsigned / "large.mov").write_bytes(b"not recognized")
        foreign = self.abandon_stage(["large.mov"])
        (foreign / "customer.txt").write_bytes(b"must not delete")
        orphan = self.abandon_stage(["large.mov", "missing.otio"])
        (orphan / "large.mov").write_bytes(b"abandoned render")
        other = create_stage(self.folder)
        self.assertFalse(orphan.exists())
        self.assertTrue(self.stage.exists(), "active stage must retain its live lease")
        self.assertTrue(unsigned.exists())
        self.assertTrue(foreign.exists())
        self.assertEqual((foreign / "customer.txt").read_bytes(), b"must not delete")
        discard_stage(other)

    @unittest.skipUnless(batch_publish.fcntl is not None, "flock required")
    def test_live_other_process_stage_lease_blocks_orphan_cleanup(self):
        live = self.abandon_stage(["speech.mov"])
        marker = live / STAGE_MARKER
        (live / "speech.mov").write_bytes(b"pending media")
        fd = os.open(marker, os.O_RDONLY)
        try:
            batch_publish.fcntl.flock(fd, batch_publish.fcntl.LOCK_EX)
            other = create_stage(self.folder)
            discard_stage(other)
            self.assertTrue(live.exists(), "a live stage must not be reaped")
        finally:
            batch_publish.fcntl.flock(fd, batch_publish.fcntl.LOCK_UN)
            os.close(fd)
        another = create_stage(self.folder)
        self.assertFalse(live.exists(), "an unlocked orphan should be cleaned")
        discard_stage(another)

    def test_backup_cleanup_failure_reports_warning_and_preserves_old_copy(self):
        originals, staged = self.manifest()
        with patch("tachie_motion.web.batch_publish.shutil.rmtree",
                   side_effect=OSError("cannot cleanup")):
            warning = self.publish(originals, staged)
        self.assertIn("recovery backup cleanup required", warning)
        self.assert_new()
        self.assertEqual(len(recovery_directories(self.folder)), 1)
        self.assertTrue((recovery_directories(self.folder)[0] / "old-0").is_file())

    def test_backup_failure_before_publication_preserves_all_outputs(self):
        originals, staged = self.manifest()
        raw_link = os.link
        def link(src, dst):
            if Path(dst).name == "old-1":
                raise OSError("cannot back up second MOV")
            return raw_link(src, dst)
        with patch("tachie_motion.web.batch_publish.os.link", side_effect=link):
            with self.assertRaisesRegex(OSError, "cannot back up"):
                self.publish(originals, staged)
        self.assert_old()
        self.assertEqual(recovery_directories(self.folder), ())


    @unittest.skipUnless(batch_publish.fcntl is not None and hasattr(os, "mkfifo"),
                         "POSIX FIFO and flock required")
    def test_fifo_owner_marker_does_not_block_or_reap_stage(self):
        orphan = self.abandon_stage(["speech.mov"])
        marker = orphan / STAGE_MARKER
        marker.unlink()
        os.mkfifo(marker)
        (orphan / "speech.mov").write_bytes(b"keep staged output")
        real_open = os.open
        def guarded_open(path, flags, *args, **kwargs):
            if path == STAGE_MARKER:
                self.assertTrue(flags & os.O_NONBLOCK, "FIFO open must be nonblocking")
            return real_open(path, flags, *args, **kwargs)
        with patch("tachie_motion.web.batch_publish.os.open", side_effect=guarded_open):
            next_stage = create_stage(self.folder)
        discard_stage(next_stage)
        self.assertTrue(stat.S_ISFIFO(marker.lstat().st_mode))
        self.assertEqual((orphan / "speech.mov").read_bytes(), b"keep staged output")

    @unittest.skipUnless(batch_publish.fcntl is not None, "flock required")
    def test_stage_with_directory_or_symlink_marker_is_preserved(self):
        stage_dir = self.abandon_stage(["speech.mov"])
        (stage_dir / STAGE_MARKER).unlink()
        (stage_dir / STAGE_MARKER).mkdir()
        stage_link = self.abandon_stage(["speech.mov"])
        (stage_link / STAGE_MARKER).unlink()
        (stage_link / STAGE_MARKER).symlink_to(self.folder / "missing")
        next_stage = create_stage(self.folder)
        discard_stage(next_stage)
        self.assertTrue((stage_dir / STAGE_MARKER).is_dir())
        self.assertTrue((stage_link / STAGE_MARKER).is_symlink())

    @unittest.skipUnless(batch_publish.fcntl is not None, "flock required")
    def test_unlisted_same_extension_and_nested_unknown_files_are_preserved(self):
        foreign_mov = self.abandon_stage(["approved.mov"])
        (foreign_mov / "approved.mov").write_bytes(b"approved")
        (foreign_mov / "unlisted.mov").write_bytes(b"unrelated same-extension movie")
        nested = self.abandon_stage(["approved.mov"])
        (nested / "approved.mov").write_bytes(b"approved")
        temporary = nested / ".tachie-preset-random"
        temporary.mkdir()
        (temporary / "staged.mov").write_bytes(b"temporary")
        (temporary / "user-notes.txt").write_bytes(b"personal notes")
        other = create_stage(self.folder)
        discard_stage(other)
        self.assertEqual((foreign_mov / "unlisted.mov").read_bytes(),
                         b"unrelated same-extension movie")
        self.assertEqual((foreign_mov / "approved.mov").read_bytes(), b"approved")
        self.assertEqual((temporary / "user-notes.txt").read_bytes(), b"personal notes")
        self.assertEqual((nested / "approved.mov").read_bytes(), b"approved")

    @unittest.skipUnless(batch_publish.fcntl is not None, "flock required")
    def test_unknown_symlink_and_missing_allowlist_are_preserved(self):
        stage_link = self.abandon_stage(["approved.mov"])
        (stage_link / "approved.mov").symlink_to(self.folder / "unrelated.mov")
        legacy = self.folder / (STAGE_PREFIX + "legacy")
        legacy.mkdir()
        (legacy / STAGE_MARKER).write_bytes(STAGE_SIGNATURE)
        (legacy / "old.mov").write_bytes(b"unindexed output")
        invalid = self.abandon_stage(["approved.mov"])
        (invalid / STAGE_ALLOWLIST).write_bytes(b"not JSON")
        other = create_stage(self.folder)
        discard_stage(other)
        self.assertTrue((stage_link / "approved.mov").is_symlink())
        self.assertTrue(legacy.exists())
        self.assertEqual((legacy / "old.mov").read_bytes(), b"unindexed output")
        self.assertTrue(invalid.exists())

    @unittest.skipUnless(batch_publish.fcntl is not None, "flock required")
    def test_late_unknown_file_during_cleanup_is_not_deleted(self):
        orphan = self.abandon_stage(["approved.mov"])
        (orphan / "approved.mov").write_bytes(b"approved")
        real_unlink = os.unlink
        injected = False
        def add_unknown_before_unlink(path, *args, **kwargs):
            nonlocal injected
            if path == "approved.mov" and kwargs.get("dir_fd") is not None and not injected:
                injected = True
                (orphan / "notes.txt").write_bytes(b"preserve me")
            return real_unlink(path, *args, **kwargs)
        with patch("tachie_motion.web.batch_publish.os.unlink",
                   side_effect=add_unknown_before_unlink):
            other = create_stage(self.folder)
        discard_stage(other)
        self.assertTrue(injected)
        self.assertEqual((orphan / "notes.txt").read_bytes(), b"preserve me")
        self.assertTrue(orphan.exists())

    @unittest.skipUnless(hasattr(os, "mkfifo"), "POSIX FIFO required")
    def test_media_swapped_to_fifo_at_sync_open_does_not_block_or_publish(self):
        original, staged = self.manifest()
        movie = self.stage / self.names[0]
        real_open = os.open
        swapped = False
        def swap_to_fifo(path, flags, *args, **kwargs):
            nonlocal swapped
            if Path(path) == movie:
                self.assertTrue(flags & os.O_NONBLOCK, "media sync open must not block")
                if not swapped:
                    swapped = True
                    movie.unlink()
                    os.mkfifo(movie)
            return real_open(path, flags, *args, **kwargs)
        with patch("tachie_motion.web.batch_publish.os.open", side_effect=swap_to_fifo):
            with self.assertRaises((FileExistsError, ValueError)):
                self.publish(original, staged)
        self.assertTrue(swapped)
        self.assertTrue(stat.S_ISFIFO(movie.lstat().st_mode))
        self.assert_old()
        self.assertEqual(recovery_directories(self.folder), ())

    def test_stage_artifact_names_reject_path_traversal_and_duplicate_targets(self):
        for names in (["../outside.mov"], ["folder/inside.otio"], ["hack\\\\file.mov"],
                      ["a.mov", "a.mov"], ["bad\\x00name.mov"]):
            with self.subTest(names=names):
                with self.assertRaises(ValueError):
                    create_stage(self.folder, allowed_files=names)
        self.assertTrue(self.stage.exists(), "existing live stage remains unchanged")


if __name__ == "__main__":
    unittest.main()
