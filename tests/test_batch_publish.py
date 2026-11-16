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
        self.assertTrue(self.stage.exists(), "unrecorded media is preserved")
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

    def _assert_link_time_stage_replacement_is_preserved(self, *, existing: bool):
        originals, staged = self.manifest(existing=existing)
        source = self.stage / self.names[0]
        target = self.folder / self.names[0]
        approved_inode = staged[self.names[0]][1]
        real_link = os.link
        swapped = False

        def replace_stage_media_before_link(src, dst):
            nonlocal swapped
            if not swapped and Path(src) == source and Path(dst) == target:
                swapped = True
                foreign = self.folder / "external-replacement.mov"
                foreign.write_bytes(b"FOREIGN-MEDIA-MUST-SURVIVE")
                os.replace(foreign, source)
                self.assertNotEqual(source.stat().st_ino, approved_inode)
            return real_link(src, dst)

        with patch("tachie_motion.web.batch_publish.os.link",
                   side_effect=replace_stage_media_before_link):
            with self.assertRaisesRegex(RuntimeError, "external writer preserved"):
                self.publish(originals, staged)

        self.assertTrue(swapped)
        if existing:
            self.assert_old()
        else:
            self.assertFalse(target.exists(), "foreign media must not be published")
            for name in self.names:
                self.assertFalse((self.folder / name).exists())

        folders = recovery_directories(self.folder)
        self.assertEqual(len(folders), 1)
        recovered = folders[0]
        self.assertEqual((recovered / "new-0").read_bytes(),
                         b"FOREIGN-MEDIA-MUST-SURVIVE")
        self.assertEqual(source.read_bytes(), b"FOREIGN-MEDIA-MUST-SURVIVE")
        if existing:
            self.assertEqual((recovered / "old-0").read_bytes(), b"OLD-0-")
        with self.assertRaisesRegex(RuntimeError, "recovery"):
            require_batch_recovery_clear(self.folder)

    def test_stage_mov_replaced_at_public_link_rolls_back_old_generation(self):
        self._assert_link_time_stage_replacement_is_preserved(existing=True)

    def test_stage_mov_replaced_at_public_link_leaves_new_targets_unpublished(self):
        self._assert_link_time_stage_replacement_is_preserved(existing=False)

    @unittest.skipUnless(os.name == "posix" and hasattr(os, "mkfifo"),
                         "POSIX FIFO and hardlink support required")
    def test_fifo_substituted_at_public_link_is_quarantined_and_restored(self):
        for existing in (True, False):
            with self.subTest(existing=existing):
                # Use a separate output directory per case so preserved
                # recovery folders do not affect the next publication.
                with tempfile.TemporaryDirectory() as tmp:
                    folder = Path(tmp)
                    stage = create_stage(folder)
                    original = {}
                    expected_stage = {}
                    for i, name in enumerate(self.names):
                        source = stage / name
                        source.write_bytes(("NEW-%s-" % i).encode())
                        destination = folder / name
                        if existing:
                            destination.write_bytes(("OLD-%s-" % i).encode())
                        original[name] = _identity(destination)
                        expected_stage[name] = published_media_identity(source)

                    source = stage / self.names[0]
                    target = folder / self.names[0]
                    real_link = os.link
                    swapped = False

                    def swap_to_fifo_before_link(src, dst):
                        nonlocal swapped
                        if not swapped and Path(src) == source and Path(dst) == target:
                            swapped = True
                            source.unlink()
                            os.mkfifo(source)
                        return real_link(src, dst)

                    with patch("tachie_motion.web.batch_publish.os.link",
                               side_effect=swap_to_fifo_before_link):
                        with self.assertRaisesRegex(RuntimeError,
                                                    "external writer preserved"):
                            publish_batch(
                                folder=folder, stage=stage,
                                movie_names=self.mov_names, timeline_name=self.otio,
                                original=original, expected_stage=expected_stage,
                            )
                    self.assertTrue(swapped)
                    recovered = recovery_directories(folder)
                    self.assertEqual(len(recovered), 1)
                    quarantined = recovered[0] / "new-0"
                    self.assertTrue(stat.S_ISFIFO(quarantined.lstat().st_mode),
                                    "a foreign FIFO must be retained as an inode")
                    self.assertTrue(stat.S_ISFIFO(source.lstat().st_mode))
                    if existing:
                        for i, name in enumerate(self.names):
                            self.assertEqual((folder / name).read_bytes(),
                                             ("OLD-%s-" % i).encode())
                        self.assertEqual((recovered[0] / "old-0").read_bytes(),
                                         b"OLD-0-")
                    else:
                        for name in self.names:
                            self.assertFalse((folder / name).exists(),
                                             "no foreign FIFO may remain published")
                    with self.assertRaisesRegex(RuntimeError, "recovery"):
                        require_batch_recovery_clear(folder)
                    discard_stage(stage)

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
    def test_restart_preserves_orphans_without_live_inode_receipts(self):
        unsigned = self.folder / (STAGE_PREFIX + "unsigned")
        unsigned.mkdir()
        (unsigned / "large.mov").write_bytes(b"not recognized")
        foreign = self.abandon_stage(["large.mov"])
        (foreign / "customer.txt").write_bytes(b"must not delete")
        orphan = self.abandon_stage(["large.mov", "missing.otio"])
        (orphan / "large.mov").write_bytes(b"abandoned render")
        other = create_stage(self.folder)
        self.assertTrue(orphan.exists(), "orphan files have no trustworthy inode receipt")
        self.assertEqual((orphan / "large.mov").read_bytes(), b"abandoned render")
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
        self.assertTrue(live.exists(), "even unlocked orphan data is retained for inspection")
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
    def test_orphan_same_name_replacement_is_never_auto_deleted(self):
        orphan = self.abandon_stage(["approved.mov"])
        (orphan / "approved.mov").write_bytes(b"third-party same name")
        other = create_stage(self.folder)
        discard_stage(other)
        self.assertEqual((orphan / "approved.mov").read_bytes(),
                         b"third-party same name")


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


    def test_expired_session_preserves_unknown_file_and_releases_lease(self):
        from tachie_motion.web.batch_session import BatchCoordinator, Session
        stage = create_stage(self.folder, allowed_files=["approved.mov"])
        (stage / "user-notes.txt").write_bytes(b"my notes")
        child = stage / ".tachie-preset-unknown"
        child.mkdir()
        (child / "information.txt").write_bytes(b"do not delete")
        coordinator = BatchCoordinator()
        coordinator.active = Session("token", self.folder, "timeline", "error",
                                     None, [], stage, -1)
        self.assertIsNone(coordinator._current())
        self.assertIsNone(coordinator.active)
        self.assertEqual((stage / "user-notes.txt").read_bytes(), b"my notes")
        self.assertEqual((child / "information.txt").read_bytes(), b"do not delete")
        self.assertNotIn(stage, batch_publish._stage_fds)

    def test_stage_release_never_unlinks_even_approved_media(self):
        stage = create_stage(self.folder, allowed_files=["approved.mov", "whole.otio"])
        mov = stage / "approved.mov"
        otio = stage / "whole.otio"
        mov.write_bytes(b"owned movie")
        otio.write_bytes(b"owned timeline")
        # A hostile peer could replace a file after any inode check.
        # Releasing must have no destructive pathname operation at all.
        with patch("tachie_motion.web.batch_publish.os.unlink",
                   side_effect=AssertionError("stage release must not unlink")):
            with patch("tachie_motion.web.batch_publish.os.rename",
                       side_effect=AssertionError("stage release must not rename")):
                discard_stage(stage)
        self.assertEqual(mov.read_bytes(), b"owned movie")
        self.assertEqual(otio.read_bytes(), b"owned timeline")
        self.assertIn(STAGE_MARKER, os.listdir(stage))
        self.assertNotIn(stage, batch_publish._stage_fds)

    def test_unrecorded_output_is_retained_during_normal_release(self):
        stage = create_stage(self.folder, allowed_files=["approved.mov"])
        (stage / "approved.mov").write_bytes(b"untracked render")
        discard_stage(stage)
        self.assertEqual((stage / "approved.mov").read_bytes(), b"untracked render")

    def test_same_named_external_replacement_has_no_deletion_race(self):
        stage = create_stage(self.folder, allowed_files=["approved.mov"])
        target = stage / "approved.mov"
        target.write_bytes(b"original staged file")
        target.unlink()
        target.write_bytes(b"foreign replacement")
        # There is no stat->unlink and no post-quarantine unlink; the foreign
        # inode is retained even when it takes over an approved filename.
        with patch("tachie_motion.web.batch_publish.os.unlink",
                   side_effect=AssertionError("unexpected unlink")):
            with patch("tachie_motion.web.batch_publish.os.rename",
                       side_effect=AssertionError("unexpected rename")):
                discard_stage(stage)
        self.assertEqual(target.read_bytes(), b"foreign replacement")
        self.assertNotIn(stage, batch_publish._stage_fds)

    def test_successful_publication_keeps_media_in_stage_until_manual_review(self):
        originals, staged = self.manifest(existing=False)
        self.publish(originals, staged)
        discard_stage(self.stage)
        self.assert_new()
        for i, name in enumerate(self.names):
            self.assertEqual((self.stage / name).read_bytes(),
                             ("NEW-%s-" % i).encode())
        self.assertNotIn(self.stage, batch_publish._stage_fds)

    def test_deep_or_invalid_allowlist_does_not_block_next_batch(self):
        stage = self.abandon_stage(["approved.mov"])
        (stage / STAGE_ALLOWLIST).write_text("[" * 4000 + "]" * 4000,
                                            encoding="utf-8")
        next_stage = create_stage(self.folder)
        self.assertTrue(next_stage.exists())
        self.assertTrue(stage.exists())
        discard_stage(next_stage)


if __name__ == "__main__":
    unittest.main()
