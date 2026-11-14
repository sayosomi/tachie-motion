"""Batch publication: rollback, collision, crash recovery and NFD names."""
import os
import stat
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tachie_motion.web.batch_publish import (
    RECOVERY_PREFIX, create_stage, discard_stage, publish_batch,
    recovery_directories, require_batch_recovery_clear,
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
            with self.assertRaisesRegex(RuntimeError, "external writer preserved"):
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


if __name__ == "__main__":
    unittest.main()
