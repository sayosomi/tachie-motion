"""Blocking audit #19: source integrity, Unicode, cross-tab lease and rollback."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

from tachie_motion.web.batch_session import (
    BatchCoordinator, source_token, validate_names,
)
from tachie_motion.web.output_destinations import (
    all_output_recovery, target_state,
)
from tachie_motion.web.preset_utterance import export_preset_utterance
from tachie_motion.web.solo_output import (
    initial_single_identity, publish_single, recovery, single_destination,
)


def make_wav(path: Path, *, char: bytes = b"\0"):
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        handle.writeframes(char * 96000)


def entry(wav: Path, name: str = "001_あんこもん") -> dict:
    return {
        "basename": name, "wav": str(wav), "source_identity": source_token(wav),
        "fps": 30, "samples": 48000, "sample_rate": 48000,
        "conflict_policy": "error",
    }


class BatchBlockingAuditTests(unittest.TestCase):
    def test_unicode_normalization_and_full_casefold_collision(self):
        cases = [
            (["Straße", "Strasse"], "movie"),
            (["CAFÉ", "cafe\u0301"], "movie"),
            (["film"], "FILM"),
        ]
        for names, timeline in cases:
            with self.subTest(names=names), self.assertRaisesRegex(ValueError, "duplicate"):
                validate_names(names, timeline)
        validate_names(["001_音声", "002_音声"], "作品")

    def test_replaced_source_rejected_even_if_same_length_before_any_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            wav = folder / "voice.wav"
            make_wav(wav)
            registered = source_token(wav)
            mov = folder / "001.mov"
            mov.write_bytes(b"ORIGINAL")
            replacement = folder / "new.wav"
            make_wav(replacement, char=b"\1")
            os.replace(replacement, wav)
            self.assertNotEqual(source_token(wav), registered)
            with self.assertRaisesRegex(ValueError, "WAV changed"):
                export_preset_utterance(
                    psd_path=folder / "missing.psd", wav=wav,
                    fingerprint="does-not-matter", layers=[], mouth=None,
                    mode="none", blink_enabled=False, mov=mov, otio=None,
                    fps=30, conflict_policy="overwrite",
                    source_identity=registered,
                )
            self.assertEqual(mov.read_bytes(), b"ORIGINAL")
            self.assertEqual(single_destination(mov)["state"], "complete")

    def test_start_rejects_changed_wav_and_does_not_claim_lease(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            wav = folder / "voice.wav"
            make_wav(wav)
            manifest = entry(wav)
            other = folder / "changed.wav"
            make_wav(other, char=b"\2")
            os.replace(other, wav)
            guard = BatchCoordinator()
            with self.assertRaisesRegex(ValueError, "WAV changed"):
                guard.start(folder, "timeline", "error", [manifest])
            self.assertIsNone(guard.active)
            self.assertEqual(list(folder.glob("*.mov")), [])

    def test_other_tab_and_legacy_exports_are_locked_until_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            wav = folder / "voice.wav"
            make_wav(wav)
            planned = entry(wav)
            guard = BatchCoordinator()
            token = guard.start(folder, "timeline", "error", [planned])
            with self.assertRaisesRegex(RuntimeError, "Another batch"):
                guard.start(folder, "second", "error", [planned])
            with self.assertRaisesRegex(RuntimeError, "Another batch"):
                guard.require_idle()
            self.assertFalse(guard.release("wrong-tab-token"))
            guard.before(token, 0, folder, planned["basename"], wav,
                         planned["source_identity"], 30, "error")
            mov = folder / (planned["basename"] + ".mov")
            mov.write_bytes(b"rendered from tab A")
            response = {"frames": 30, "sample_count": 48000, "sample_rate": 48000}
            guard.succeeded(token, 0, response)
            materialized = [{ "basename": planned["basename"], "frames": 30,
                              "fps": 30, "samples": 48000, "sample_rate": 48000 }]
            self.assertEqual(len(guard.before_timeline(token, folder, "timeline",
                                                       "error", materialized)), 1)
            substitute = folder / "replacement.mov"
            substitute.write_bytes(b"rendered from tab B")
            os.replace(substitute, mov)
            with self.assertRaisesRegex(ValueError, "replaced"):
                guard.before_timeline(token, folder, "timeline", "error", materialized)
            self.assertTrue(guard.release(token))
            guard.require_idle()

    def test_missing_and_reversed_order_reject_before_next_movie(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            wav = folder / "voice.wav"
            make_wav(wav)
            planned = entry(wav)
            guard = BatchCoordinator()
            token = guard.start(folder, "timeline", "error",
                                [planned, {**planned, "basename": "002_あんこもん"}])
            with self.assertRaisesRegex(ValueError, "order"):
                guard.before(token, 1, folder, "002_あんこもん", wav,
                             planned["source_identity"], 30, "error")
            with self.assertRaisesRegex(ValueError, "incomplete"):
                guard.before_timeline(token, folder, "timeline", "error", [])
            self.assertTrue(guard.release(token))

    def test_recovery_state_is_shared_between_pair_and_single_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            mov, otio = folder / "shared.mov", folder / "shared.otio"
            old_pair = folder / ".shared.tachie-backup"
            old_pair.mkdir()
            (old_pair / "saved.mov").write_bytes(b"old MOV")
            (old_pair / "saved.otio").write_bytes(b"old OTIO")
            self.assertEqual(single_destination(mov)["state"], "recovery_required")
            self.assertEqual(single_destination(otio)["state"], "recovery_required")
            with self.assertRaisesRegex(RuntimeError, "recovery"):
                initial_single_identity(otio, "error")
            old_pair.rename(folder / ".no-longer-recovery")
            orphan = recovery(otio)
            orphan.mkdir()
            self.assertEqual(target_state(mov, otio)[0], "recovery_required")
            self.assertIn(orphan, all_output_recovery(mov))
            with self.assertRaisesRegex(RuntimeError, "recovery"):
                initial_single_identity(mov, "error")
            orphan.rename(folder / ".no-longer-recovery-2")
            self.assertEqual(target_state(mov, otio)[0], "available")

    def test_overwrite_failures_restore_old_bytes_and_do_not_hide_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            old = folder / "clip.mov"
            staged = folder / "staged.mov"
            cases = ["backup_link", "move_old", "publish_new"]
            for case in cases:
                old.write_bytes(b"OLD")
                staged.write_bytes(b"NEW")
                prior = initial_single_identity(old, "overwrite")
                real_link, real_rename = os.link, os.rename
                def link(src, dst):
                    if case == "backup_link" and Path(src) == old:
                        raise OSError("injected backup link failure")
                    if case == "publish_new" and Path(src) == staged and Path(dst) == old:
                        raise OSError("injected publication failure")
                    return real_link(src, dst)
                def rename(src, dst):
                    if case == "move_old" and Path(src) == old:
                        raise OSError("injected old-file move failure")
                    return real_rename(src, dst)
                with self.subTest(case=case), patch(
                    "tachie_motion.web.solo_output.os.link", side_effect=link
                ), patch("tachie_motion.web.solo_output.os.rename", side_effect=rename):
                    with self.assertRaises(OSError):
                        publish_single(staged, old, policy="overwrite", prior=prior)
                self.assertEqual(old.read_bytes(), b"OLD")
                self.assertFalse(recovery(old).exists())

    def test_cleanup_failure_returns_warning_and_blocks_future_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            old = folder / "clip.mov"
            staged = folder / "staged.mov"
            old.write_bytes(b"OLD")
            staged.write_bytes(b"NEW")
            prior = initial_single_identity(old, "overwrite")
            with patch("tachie_motion.web.solo_output.shutil.rmtree",
                       side_effect=OSError("injected cleanup failure")):
                warning = publish_single(staged, old, policy="overwrite", prior=prior)
            self.assertIn("inspect recovery directory", warning)
            self.assertEqual(old.read_bytes(), b"NEW")
            self.assertEqual(single_destination(old)["state"], "recovery_required")
            self.assertTrue((recovery(old) / "saved").exists())


if __name__ == "__main__":
    unittest.main()
