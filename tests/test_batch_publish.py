"""Batch publication: rollback, collision, crash recovery and NFD names."""
import os
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
