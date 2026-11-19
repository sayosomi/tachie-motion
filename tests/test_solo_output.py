"""Synthetic tests for solo MOV reference safety and batch-recovery preflight."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tachie_motion.web.solo_output import (
    initial_single_identity, publish_single, single_destination,
    solo_destination_info,
)


class SoloOtioProtectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.mov = self.folder / "speech.mov"
        self.stage = self.folder / "stage.mov"
        self.stage.write_bytes(b"NEW MOV")

    def test_existing_mov_without_otio_allows_overwrite(self):
        self.mov.write_bytes(b"OLD MOV")
        self.assertEqual(solo_destination_info(self.folder, "speech")["state"], "complete")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                       protect_otio_references=True)
        self.assertEqual(self.mov.read_bytes(), b"NEW MOV")
        self.assertFalse((self.folder / ".speech.mov.single-backup").exists())

    def test_foreign_combined_otio_blocks_preflight_but_not_fresh_mov(self):
        self.mov.write_bytes(b"OLD MOV")
        timeline = self.folder / "project.otio"
        timeline.write_bytes(b"EXISTING COMBINED OTIO")
        probe = solo_destination_info(self.folder, "speech")
        self.assertEqual(probe["state"], "unsafe")
        self.assertEqual(probe["suggested_basename"], "speech_002")
        with self.assertRaisesRegex(ValueError, "Another OTIO"):
            initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        # The batch route has a separate guard; this opt-in does not change it.
        self.assertIsNotNone(initial_single_identity(self.mov, "overwrite"))
        self.assertEqual(single_destination(self.folder / "fresh.mov",
                                            protect_otio_references=True)["state"],
                         "available")
        self.assertEqual(timeline.read_bytes(), b"EXISTING COMBINED OTIO")
        self.assertEqual(self.mov.read_bytes(), b"OLD MOV")

    def test_foreign_otio_arriving_during_render_blocks_publish(self):
        self.mov.write_bytes(b"OLD MOV")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        timeline = self.folder / "project.otio"
        timeline.write_bytes(b"ADDED AFTER PREFLIGHT")
        with self.assertRaisesRegex(ValueError, "Another OTIO"):
            publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                           protect_otio_references=True)
        self.assertEqual(self.mov.read_bytes(), b"OLD MOV")
        self.assertEqual(timeline.read_bytes(), b"ADDED AFTER PREFLIGHT")
        self.assertFalse((self.folder / ".speech.mov.single-backup").exists())

    def test_foreign_otio_appearing_during_backup_keeps_original(self):
        self.mov.write_bytes(b"OLD MOV")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        timeline = self.folder / "project.otio"
        link = os.link

        def inject(source, destination):
            result = link(source, destination)
            if Path(source) == self.mov and Path(destination).name == "saved":
                timeline.write_bytes(b"ADDED WHILE BACKING UP")
            return result

        with patch("tachie_motion.web.solo_output.os.link", side_effect=inject):
            with self.assertRaisesRegex(ValueError, "Another OTIO"):
                publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                               protect_otio_references=True)
        self.assertEqual(self.mov.read_bytes(), b"OLD MOV")
        self.assertEqual(timeline.read_bytes(), b"ADDED WHILE BACKING UP")
        self.assertFalse((self.folder / ".speech.mov.single-backup").exists())

    def test_foreign_otio_appearing_after_atomic_old_mov_move_rolls_back(self):
        self.mov.write_bytes(b"OLD MOV")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        timeline = self.folder / "project.otio"
        from tachie_motion.web.atomic_rename import rename_noreplace
        def inject(source, destination):
            rename_noreplace(source, destination)
            if Path(source) == self.mov and Path(destination).name == "removed":
                timeline.write_bytes(b"ADDED DURING PUBLICATION")

        with patch("tachie_motion.web.solo_output.rename_noreplace", side_effect=inject):
            with self.assertRaisesRegex(ValueError, "Another OTIO"):
                publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                               protect_otio_references=True)
        self.assertEqual(self.mov.read_bytes(), b"OLD MOV")
        self.assertEqual(timeline.read_bytes(), b"ADDED DURING PUBLICATION")
        self.assertFalse((self.folder / ".speech.mov.single-backup").exists())

    def test_foreign_otio_appearing_at_new_mov_link_rolls_back(self):
        self.mov.write_bytes(b"OLD MOV")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        timeline = self.folder / "project.otio"
        link = os.link

        def inject(source, destination):
            result = link(source, destination)
            if Path(source) == self.stage and Path(destination) == self.mov:
                timeline.write_bytes(b"ADDED AT FINAL LINK")
            return result

        with patch("tachie_motion.web.solo_output.os.link", side_effect=inject):
            with self.assertRaisesRegex(ValueError, "Another OTIO"):
                publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                               protect_otio_references=True)
        self.assertEqual(self.mov.read_bytes(), b"OLD MOV")
        self.assertEqual(timeline.read_bytes(), b"ADDED AT FINAL LINK")
        self.assertFalse((self.folder / ".speech.mov.single-backup").exists())

    def test_external_removed_file_is_not_replaced_or_deleted(self):
        self.mov.write_bytes(b"OLD MOV")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        link = os.link
        backup = self.folder / ".speech.mov.single-backup"
        external = backup / "removed"

        def inject(source, destination, *args, **kwargs):
            result = link(source, destination, *args, **kwargs)
            if Path(source) == self.mov and Path(destination).name == "saved":
                external.write_bytes(b"THIRD-PARTY REMOVED")
            return result

        with patch("tachie_motion.web.solo_output.os.link", side_effect=inject):
            with self.assertRaisesRegex(RuntimeError, "Backup cleanup required"):
                publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                               protect_otio_references=True)
        self.assertEqual(self.mov.read_bytes(), b"OLD MOV")
        self.assertEqual(external.read_bytes(), b"THIRD-PARTY REMOVED")
        self.assertEqual((backup / "saved").read_bytes(), b"OLD MOV")
        self.assertEqual(self.stage.read_bytes(), b"NEW MOV")

    def test_external_uncommitted_file_is_not_replaced_or_deleted(self):
        self.mov.write_bytes(b"OLD MOV")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        backup = self.folder / ".speech.mov.single-backup"
        external = backup / "uncommitted"
        timeline = self.folder / "project.otio"
        link = os.link

        def inject(source, destination, *args, **kwargs):
            result = link(source, destination, *args, **kwargs)
            if Path(source) == self.stage and Path(destination) == self.mov:
                external.write_bytes(b"THIRD-PARTY UNCOMMITTED")
                timeline.write_bytes(b"OTIO ARRIVED")
            return result

        with patch("tachie_motion.web.solo_output.os.link", side_effect=inject):
            with self.assertRaisesRegex(RuntimeError, "Overwrite recovery required"):
                publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                               protect_otio_references=True)
        self.assertEqual(external.read_bytes(), b"THIRD-PARTY UNCOMMITTED")
        self.assertEqual((backup / "saved").read_bytes(), b"OLD MOV")
        self.assertEqual((backup / "removed").read_bytes(), b"OLD MOV")
        self.assertEqual(self.mov.read_bytes(), b"NEW MOV")
        self.assertEqual(timeline.read_bytes(), b"OTIO ARRIVED")
        with self.assertRaisesRegex(RuntimeError, "needs recovery"):
            initial_single_identity(self.mov, "overwrite", protect_otio_references=True)

    def test_success_cleanup_retains_external_backup_entry_and_warns(self):
        self.mov.write_bytes(b"OLD MOV")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        backup = self.folder / ".speech.mov.single-backup"
        extra = backup / "unknown.bin"
        link = os.link

        def inject(source, destination, *args, **kwargs):
            result = link(source, destination, *args, **kwargs)
            if Path(source) == self.stage and Path(destination) == self.mov:
                extra.write_bytes(b"OTHER WRITER DATA")
            return result

        with patch("tachie_motion.web.solo_output.os.link", side_effect=inject):
            warning = publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                                     protect_otio_references=True)
        self.assertIn("inspect recovery directory", warning)
        self.assertEqual(self.mov.read_bytes(), b"NEW MOV")
        self.assertEqual(extra.read_bytes(), b"OTHER WRITER DATA")
        self.assertEqual((backup / "saved").read_bytes(), b"OLD MOV")
        self.assertEqual((backup / "removed").read_bytes(), b"OLD MOV")

    def test_old_mov_replacement_at_atomic_move_preserves_both_inodes(self):
        self.mov.write_bytes(b"OLD MOV")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        outsider = self.folder / "third-party.mov"
        outsider.write_bytes(b"THIRD-PARTY MOV")
        from tachie_motion.web.atomic_rename import rename_noreplace
        def inject(source, destination):
            if Path(source) == self.mov and Path(destination).name == "removed":
                os.replace(outsider, self.mov)
            rename_noreplace(source, destination)

        with patch("tachie_motion.web.solo_output.rename_noreplace", side_effect=inject):
            with self.assertRaisesRegex(RuntimeError, "Overwrite recovery required"):
                publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                               protect_otio_references=True)
        backup = self.folder / ".speech.mov.single-backup"
        self.assertEqual(self.mov.read_bytes(), b"OLD MOV")
        self.assertEqual((backup / "saved").read_bytes(), b"OLD MOV")
        self.assertEqual((backup / "removed").read_bytes(), b"THIRD-PARTY MOV")

    def test_published_mov_replacement_at_atomic_rollback_keeps_third_party(self):
        self.mov.write_bytes(b"OLD MOV")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        outsider = self.folder / "third-party.mov"
        outsider.write_bytes(b"THIRD-PARTY MOV")
        timeline = self.folder / "project.otio"
        from tachie_motion.web.atomic_rename import rename_noreplace
        def injected_link(source, destination):
            result = os.link(source, destination)
            if Path(source) == self.stage and Path(destination) == self.mov:
                timeline.write_bytes(b"OTIO ARRIVED")
            return result
        def injected_move(source, destination):
            if Path(source) == self.mov and Path(destination).name == "uncommitted":
                os.replace(outsider, self.mov)
            rename_noreplace(source, destination)

        with patch("tachie_motion.web.solo_output.os.link", side_effect=injected_link):
            with patch("tachie_motion.web.solo_output.rename_noreplace",
                       side_effect=injected_move):
                with self.assertRaisesRegex(RuntimeError, "Overwrite recovery required"):
                    publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                                   protect_otio_references=True)
        backup = self.folder / ".speech.mov.single-backup"
        self.assertEqual(self.mov.read_bytes(), b"OLD MOV")
        self.assertEqual((backup / "uncommitted").read_bytes(), b"THIRD-PARTY MOV")
        self.assertEqual((backup / "saved").read_bytes(), b"OLD MOV")

    def test_archive_entry_replacement_is_retained_without_unlink(self):
        self.mov.write_bytes(b"OLD MOV")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        from tachie_motion.web.atomic_rename import rename_noreplace
        def inject(source, destination):
            if Path(source).name == ".speech.mov.single-backup":
                replacement = self.folder / "outsider"
                replacement.write_bytes(b"THIRD PARTY SAVED")
                os.replace(replacement, Path(source) / "saved")
            rename_noreplace(source, destination)
        with patch("tachie_motion.web.solo_output.rename_noreplace", side_effect=inject):
            with patch("tachie_motion.web.solo_output.os.unlink",
                       side_effect=AssertionError("No auto unlink is safe")):
                warning = publish_single(self.stage, self.mov, policy="overwrite",
                                         prior=prior, protect_otio_references=True)
        self.assertIn("retained for manual cleanup", warning)
        archives = list(self.folder.glob(".speech.mov.single-backup-retained-*"))
        self.assertEqual(len(archives), 1)
        self.assertEqual((archives[0] / "saved").read_bytes(), b"THIRD PARTY SAVED")
        self.assertEqual((archives[0] / "removed").read_bytes(), b"OLD MOV")
        self.assertEqual(self.mov.read_bytes(), b"NEW MOV")

    def test_archive_does_not_block_next_overwrite(self):
        self.mov.write_bytes(b"ORIGINAL")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                       protect_otio_references=True)
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        self.stage.write_bytes(b"SECOND MOV")
        publish_single(self.stage, self.mov, policy="overwrite", prior=prior,
                       protect_otio_references=True)
        archives = sorted(self.folder.glob(".speech.mov.single-backup-retained-*"))
        self.assertEqual(len(archives), 2)
        old_versions = sorted((a / "saved").read_bytes() for a in archives)
        self.assertEqual(old_versions, [b"NEW MOV", b"ORIGINAL"])
        self.assertEqual(self.mov.read_bytes(), b"SECOND MOV")

    def test_batch_recovery_returns_diagnostic_without_candidate_scan(self):
        recovery = self.folder / ".tachie-batch-recovery-test"
        recovery.mkdir()
        (recovery / "manifest.json").write_text('{"protected":true}')
        with patch("tachie_motion.web.solo_output.single_destination",
                   side_effect=AssertionError("No candidate scan allowed")):
            probe = solo_destination_info(self.folder, "speech")
        self.assertEqual(probe, {
            "state": "recovery_required", "suggested_basename": "",
            "folder_recovery_required": True,
        })
        self.assertEqual((recovery / "manifest.json").read_text(),
                         '{"protected":true}')
        with self.assertRaisesRegex(RuntimeError, "needs recovery"):
            initial_single_identity(self.mov, "error", protect_otio_references=True)

    def test_same_basename_recovery_still_offers_alternate(self):
        recovery = self.folder / ".speech.failed-simulated"
        recovery.mkdir()
        probe = solo_destination_info(self.folder, "speech")
        self.assertEqual(probe["state"], "recovery_required")
        self.assertEqual(probe["suggested_basename"], "speech_002")
        self.assertFalse(probe.get("folder_recovery_required", False))


if __name__ == "__main__":
    unittest.main()
