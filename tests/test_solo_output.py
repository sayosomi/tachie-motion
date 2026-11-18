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

    def test_foreign_otio_appearing_after_old_mov_rename_rolls_back(self):
        self.mov.write_bytes(b"OLD MOV")
        prior = initial_single_identity(self.mov, "overwrite", protect_otio_references=True)
        timeline = self.folder / "project.otio"
        rename = os.rename

        def inject(source, destination):
            result = rename(source, destination)
            if Path(source) == self.mov and Path(destination).name == "removed":
                timeline.write_bytes(b"ADDED DURING PUBLICATION")
            return result

        with patch("tachie_motion.web.solo_output.os.rename", side_effect=inject):
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
