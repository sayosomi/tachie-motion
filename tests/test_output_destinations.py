"""Output name collision and two-file overwrite protection (synthetic only)."""

import os
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
import tempfile

from tachie_motion.web.output_destinations import (
    available_name, backup_location, destination_info,
    initial_target_identity, publish_pair, target_state,
)


class OutputDestinationTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.mov = self.root / "speech.mov"
        self.otio = self.root / "speech.otio"

    def files(self, mov=b"OLDMOV", otio=b"OLDOTIO"):
        self.mov.write_bytes(mov)
        self.otio.write_bytes(otio)

    def staged(self):
        staged_mov = self.root / "staged.mov"
        staged_otio = self.root / "staged.otio"
        staged_mov.write_bytes(b"NEWMOV")
        staged_otio.write_bytes(b"NEWOTIO")
        return staged_mov, staged_otio

    def test_available_full_partial_and_unsafe_pairs(self):
        self.assertEqual(destination_info(self.root, "speech"), {
            "state": "available", "suggested_basename": "speech",
        })
        self.mov.write_bytes(b"old")
        self.assertEqual(target_state(self.mov, self.otio)[0], "partial")
        self.assertEqual(available_name(self.root, "speech"), "speech_002")
        self.otio.write_bytes(b"other")
        self.assertEqual(target_state(self.mov, self.otio)[0], "complete")
        (self.root / "speech_002.mov").write_bytes(b"taken")
        self.assertEqual(available_name(self.root, "speech"), "speech_003")
        self.mov.unlink()
        self.mov.symlink_to(self.otio)
        self.assertEqual(target_state(self.mov, self.otio)[0], "unsafe")
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            initial_target_identity(self.mov, self.otio, "overwrite")

    def test_name_bounds_and_invalid_policy(self):
        with self.assertRaises(ValueError):
            available_name(self.root, "../path")
        with self.assertRaises(ValueError):
            available_name(self.root, "日本語")
        self.files()
        long_name = "z" * 64
        (self.root / (long_name + ".mov")).write_bytes(b"x")
        suggestion = available_name(self.root, long_name)
        self.assertLessEqual(len(suggestion), 64)
        self.assertTrue(suggestion.endswith("_002"))
        with self.assertRaisesRegex(ValueError, "policy"):
            initial_target_identity(self.mov, self.otio, "whatever")

    def test_new_publish_does_not_replace_either_existing_file(self):
        self.mov.write_bytes(b"sentinel")
        stages = self.staged()
        with self.assertRaisesRegex(ValueError, "Only one"):
            initial_target_identity(self.mov, self.otio, "error")
        with self.assertRaises(FileExistsError):
            publish_pair(*stages, self.mov, self.otio, policy="error", prior=None)
        self.assertEqual(self.mov.read_bytes(), b"sentinel")
        self.assertFalse(self.otio.exists())

    def test_new_export_aborts_before_publish_if_recovery_creation_fails(self):
        stages = self.staged()
        with patch("tachie_motion.web.output_destinations.tempfile.mkdtemp",
                   side_effect=OSError("no space for recovery")):
            with patch("tachie_motion.web.output_destinations.os.link") as link:
                with self.assertRaisesRegex(OSError, "no space"):
                    publish_pair(*stages, self.mov, self.otio,
                                 policy="error", prior=None)
                link.assert_not_called()
        self.assertFalse(self.mov.exists())
        self.assertFalse(self.otio.exists())

    def test_fresh_second_link_failure_rolls_back_without_residue(self):
        stages = self.staged()
        original = os.link

        def fail_otio(source, target):
            if source == stages[1] and target == self.otio:
                raise OSError("synthetic OTIO publish failure")
            return original(source, target)

        with patch("tachie_motion.web.output_destinations.os.link",
                   side_effect=fail_otio):
            with self.assertRaisesRegex(OSError, "OTIO publish failure"):
                publish_pair(*stages, self.mov, self.otio,
                             policy="error", prior=None)
        self.assertEqual(target_state(self.mov, self.otio)[0], "available")
        self.assertEqual(list(self.root.glob(".speech.failed-*")), [])

    def test_pair_overwrite_and_pair_backup_removed_on_success(self):
        self.files()
        old = initial_target_identity(self.mov, self.otio, "overwrite")
        publish_pair(*self.staged(), self.mov, self.otio, policy="overwrite", prior=old)
        self.assertEqual(self.mov.read_bytes(), b"NEWMOV")
        self.assertEqual(self.otio.read_bytes(), b"NEWOTIO")
        self.assertFalse(backup_location(self.mov).exists())

    def test_second_publication_failure_rolls_back_both_outputs(self):
        self.files()
        old = initial_target_identity(self.mov, self.otio, "overwrite")
        stages = self.staged()
        real_link = os.link

        def fail_second(source, target):
            if source == stages[1] and target == self.otio:
                raise OSError("synthetic OTIO publication failure")
            return real_link(source, target)

        with patch("tachie_motion.web.output_destinations.os.link", side_effect=fail_second):
            with self.assertRaisesRegex(OSError, "OTIO publication failure"):
                publish_pair(*stages, self.mov, self.otio,
                             policy="overwrite", prior=old)
        self.assertEqual(self.mov.read_bytes(), b"OLDMOV")
        self.assertEqual(self.otio.read_bytes(), b"OLDOTIO")
        self.assertFalse(backup_location(self.mov).exists())

    def test_render_race_and_interrupted_backup_fail_closed(self):
        self.files()
        old = initial_target_identity(self.mov, self.otio, "overwrite")
        stages = self.staged()
        self.otio.write_bytes(b"OTHER")
        with self.assertRaisesRegex(FileExistsError, "changed"):
            publish_pair(*stages, self.mov, self.otio,
                         policy="overwrite", prior=old)
        self.assertEqual(self.mov.read_bytes(), b"OLDMOV")
        self.assertEqual(self.otio.read_bytes(), b"OTHER")
        backup = backup_location(self.mov)
        backup.mkdir()
        (backup / "original.mov").write_bytes(b"restorable")
        self.assertEqual(target_state(self.mov, self.otio)[0], "recovery_required")
        with self.assertRaisesRegex(RuntimeError, "needs recovery"):
            initial_target_identity(self.mov, self.otio, "overwrite")
        self.assertEqual((backup / "original.mov").read_bytes(), b"restorable")
 
    def test_external_replacement_during_final_rename_is_preserved(self):
        self.files()
        old = initial_target_identity(self.mov, self.otio, "overwrite")
        stages = self.staged()
        real_rename = os.rename
        recovery = backup_location(self.mov)
        racer = self.root / "racer.mov"

        def replace_before_rename(source, target):
            if source == self.mov and target == recovery / "removed.mov":
                racer.write_bytes(b"EXTERNAL")
                os.replace(racer, self.mov)
            return real_rename(source, target)

        with patch("tachie_motion.web.output_destinations.os.rename",
                   side_effect=replace_before_rename):
            with self.assertRaisesRegex(RuntimeError, "rollback incomplete"):
                publish_pair(*stages, self.mov, self.otio,
                             policy="overwrite", prior=old)
        self.assertEqual(self.mov.read_bytes(), b"OLDMOV")
        self.assertEqual(self.otio.read_bytes(), b"OLDOTIO")
        self.assertEqual((recovery / "removed.mov").read_bytes(), b"EXTERNAL")
        self.assertEqual((recovery / "saved.mov").read_bytes(), b"OLDMOV")
        self.assertEqual(target_state(self.mov, self.otio)[0], "recovery_required")

    def test_external_creation_before_exclusive_publish_is_not_overwritten(self):
        self.files()
        old = initial_target_identity(self.mov, self.otio, "overwrite")
        stages = self.staged()
        real_link = os.link

        def race_on_publish(source, target):
            if source == stages[0] and target == self.mov:
                self.mov.write_bytes(b"EXTERNAL")
            return real_link(source, target)

        with patch("tachie_motion.web.output_destinations.os.link",
                   side_effect=race_on_publish):
            with self.assertRaisesRegex(RuntimeError, "rollback incomplete"):
                publish_pair(*stages, self.mov, self.otio,
                             policy="overwrite", prior=old)
        self.assertEqual(self.mov.read_bytes(), b"EXTERNAL")
        self.assertEqual(self.otio.read_bytes(), b"OLDOTIO")
        self.assertEqual((backup_location(self.mov) / "saved.mov").read_bytes(), b"OLDMOV")
        self.assertEqual(target_state(self.mov, self.otio)[0], "recovery_required")

    def test_post_commit_cleanup_failure_returns_success_warning(self):
        self.files()
        old = initial_target_identity(self.mov, self.otio, "overwrite")
        with patch("tachie_motion.web.output_destinations.shutil.rmtree",
                   side_effect=OSError("cleanup denied")):
            warning = publish_pair(*self.staged(), self.mov, self.otio,
                                   policy="overwrite", prior=old)
        self.assertIn("were saved", warning)
        self.assertEqual(self.mov.read_bytes(), b"NEWMOV")
        self.assertEqual(self.otio.read_bytes(), b"NEWOTIO")
        self.assertEqual(target_state(self.mov, self.otio)[0], "recovery_required")

    def test_new_export_rollback_does_not_delete_external_replacement(self):
        stages = self.staged()
        real_link = os.link
        external = self.root / "external.mov"

        def collide_with_new_publish(source, target):
            if source == stages[1] and target == self.otio:
                external.write_bytes(b"EXTERNAL")
                os.replace(external, self.mov)
                raise OSError("synthetic second publish failure")
            return real_link(source, target)

        with patch("tachie_motion.web.output_destinations.os.link",
                   side_effect=collide_with_new_publish):
            with self.assertRaisesRegex(RuntimeError, "rollback incomplete"):
                publish_pair(*stages, self.mov, self.otio,
                             policy="error", prior=None)
        backups = list(self.root.glob(".speech.failed-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "candidate.mov").read_bytes(), b"EXTERNAL")
        self.assertFalse(self.mov.exists())
        self.assertFalse(self.otio.exists())
        self.assertEqual(target_state(self.mov, self.otio)[0], "recovery_required")
        self.assertEqual(destination_info(self.root, "speech")["state"], "recovery_required")
        with self.assertRaisesRegex(RuntimeError, "needs recovery"):
            initial_target_identity(self.mov, self.otio, "error")
        with self.assertRaisesRegex(FileExistsError, "changed"):
            publish_pair(*stages, self.mov, self.otio, policy="error", prior=None)
        self.assertEqual((backups[0] / "candidate.mov").read_bytes(), b"EXTERNAL")

    def test_successful_new_pair_with_cleanup_failure_stays_committed(self):
        stages = self.staged()
        with patch("tachie_motion.web.output_destinations.shutil.rmtree",
                   side_effect=OSError("synthetic recovery directory cleanup failure")):
            warning = publish_pair(*stages, self.mov, self.otio,
                                   policy="error", prior=None)
        self.assertIn("were saved", warning)
        self.assertEqual(self.mov.read_bytes(), b"NEWMOV")
        self.assertEqual(self.otio.read_bytes(), b"NEWOTIO")
        self.assertEqual(target_state(self.mov, self.otio)[0], "recovery_required")
