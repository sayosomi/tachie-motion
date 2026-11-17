"""Synthetic, read-only tests for strict sibling LAB inspection (Issue #21)."""

import hashlib
import os
from pathlib import Path
import tempfile
import unittest
import wave
from unittest.mock import patch

from tachie_motion.audio.lab import (
    MAX_LAB_BYTES, TICKS_PER_SECOND, inspect_adjacent_lab, parse_lab,
)


def make_wav(path: Path, *, samples: int = 1000, rate: int = 1000) -> None:
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"\0\0" * samples)


def fingerprint(path: Path) -> tuple[int, int, int, int, int]:
    info = path.stat()
    return info.st_dev, info.st_ino, info.st_ctime_ns, info.st_size, info.st_mtime_ns


class LabTests(unittest.TestCase):
    def test_exact_tick_intervals_gaps_phonemes_and_determinism(self):
        contents = (
            "0 2000000 pau\r\n"
            "2000000 3000000 gw\r\n"
            "3000000 4000000 kw\r\n"
            "4000000 5000000 a\r\n"
            "5500000 8000000 N\r\n"
            "8000000 10000000 sil\r\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "音声 e\u0301.wav"
            lab = wav.with_suffix(".lab")
            make_wav(wav)
            lab.write_bytes(b"\xef\xbb\xbf" + contents.encode("utf-8"))
            wav_before = hashlib.sha256(wav.read_bytes()).hexdigest()
            lab_before = lab.read_bytes()
            a = inspect_adjacent_lab(wav, expected_wav_identity=fingerprint(wav))
            b = inspect_adjacent_lab(wav)
            self.assertEqual(a, b)
            self.assertEqual(a.status, "valid")
            self.assertEqual(a.reason, None)
            self.assertEqual([p.phoneme for p in a.intervals], ["pau", "gw", "kw", "a", "N", "sil"])
            self.assertEqual(a.intervals[0].start_tick, 0)
            self.assertEqual(a.intervals[-1].end_tick, TICKS_PER_SECOND)
            self.assertEqual(hashlib.sha256(wav.read_bytes()).hexdigest(), wav_before)
            self.assertEqual(lab.read_bytes(), lab_before)
            # NFD name must be used without NFC fallback to a different file.
            self.assertNotEqual(wav.name, "音声 é.wav")

    def test_missing_lab_and_no_unicode_normalization(self):
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "声 e\u0301.wav"
            make_wav(wav)
            normalized = Path(tmp) / "声 é.lab"
            normalized.write_text("0 10000000 a\n", encoding="utf-8")
            sibling = wav.with_suffix(".lab")
            inspection = inspect_adjacent_lab(wav)
            self.assertEqual(inspection.path, sibling)
            # APFS often resolves NFC/NFD spellings to the same directory
            # entry. Only normalization-sensitive filesystems can require
            # "missing"; preserve the requested NFD string on either kind.
            if sibling.exists():
                self.assertTrue(sibling.samefile(normalized))
                self.assertEqual(inspection.status, "valid")
                self.assertEqual([part.phoneme for part in inspection.intervals], ["a"])
            else:
                self.assertEqual(inspection.status, "missing")
                self.assertFalse(inspection.intervals)
                self.assertIsNone(inspection.reason)
            self.assertEqual(normalized.read_text(encoding="utf-8"), "0 10000000 a\n")

    def test_invalid_fields_phonemes_and_timestamps(self):
        cases = (
            ("", "no intervals"),
            ("0 1000000\n", "expected"),
            ("0 1000000 a extra\n", "expected"),
            ("0.0 1000000 a\n", "integer"),
            ("-1 1000000 a\n", "integer"),
            ("0 0 a\n", "nonpositive"),
            ("100 99 a\n", "nonpositive"),
            ("0 3000000 a\n2000000 4000000 i\n", "overlapping"),
            ("0 10000000 a\n10000000 10000001 i\n", "exceeds WAV"),
            ("0 10000001 a\n", "exceeds WAV"),
            ("0 1000000 mystery\n", "unsupported phoneme"),
            ("0 1000000 あ\n", "unsupported phoneme"),
            ("0 1000000 a\n\n", "expected"),
            ("0 1000000 a\n\n1000000 2000000 i", "expected"),
            ("0 99999999999999999 a\n", "integer"),
        )
        for content, expected in cases:
            with self.subTest(content=content):
                with self.assertRaisesRegex(ValueError, expected):
                    parse_lab(content, samples=1000, sample_rate=1000)

    def test_fractional_sample_boundary_is_exact_without_rounding(self):
        # At 48kHz, 208 ticks is 0.9984 sample; 209 ticks exceeds one sample.
        self.assertEqual(
            parse_lab("0 208 a\n", samples=1, sample_rate=48000)[0].end_tick, 208
        )
        with self.assertRaisesRegex(ValueError, "exceeds WAV"):
            parse_lab("0 209 a\n", samples=1, sample_rate=48000)

    def test_invalid_wav_and_expected_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wav = root / "speech.wav"
            self.assertEqual(inspect_adjacent_lab(wav).status, "invalid")
            make_wav(wav)
            identity = fingerprint(wav)
            result = inspect_adjacent_lab(wav, expected_wav_identity=identity)
            self.assertEqual(result.status, "missing")
            changed = identity[:2] + (identity[2] + 1,) + identity[3:]
            self.assertIn("since registration", inspect_adjacent_lab(
                wav, expected_wav_identity=changed
            ).reason)
            wav.write_bytes(b"bad")
            self.assertEqual(inspect_adjacent_lab(wav).status, "invalid")

    def test_lab_encoding_limit_and_nonregular_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wav = root / "speech.wav"
            lab = wav.with_suffix(".lab")
            make_wav(wav)
            lab.write_bytes(b"\xff")
            self.assertIn("UTF-8", inspect_adjacent_lab(wav).reason)
            lab.write_bytes(b" " * (MAX_LAB_BYTES + 1))
            self.assertIn("size limit", inspect_adjacent_lab(wav).reason)
            lab.unlink()
            lab.mkdir()
            self.assertEqual(inspect_adjacent_lab(wav).status, "invalid")
            lab.rmdir()
            try:
                lab.symlink_to(root / "not-created.lab")
            except (OSError, NotImplementedError):
                pass  # Platform permissions may disallow symlinks.
            else:
                self.assertIn("symlinks", inspect_adjacent_lab(wav).reason)
                lab.unlink()
            if hasattr(os, "mkfifo"):
                os.mkfifo(lab)
                try:
                    self.assertIn("regular file", inspect_adjacent_lab(wav).reason)
                finally:
                    lab.unlink()

    def test_lab_race_and_wav_replacement_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wav = root / "speech.wav"
            lab = wav.with_suffix(".lab")
            make_wav(wav)
            lab.write_text("0 10000000 a\n", encoding="utf-8")
            from tachie_motion.audio import lab as module
            original_fstat = os.fstat
            lab_inode = lab.stat().st_ino
            lab_checks = 0

            def changed_lab_stat(descriptor):
                nonlocal lab_checks
                info = original_fstat(descriptor)
                if info.st_ino == lab_inode:
                    lab_checks += 1
                    if lab_checks == 2:
                        # Change the second fd-based LAB identity, not WAV's.
                        values = list(info)
                        values[1] += 1
                        return os.stat_result(values)
                return info

            with patch.object(module.os, "fstat", side_effect=changed_lab_stat):
                result = inspect_adjacent_lab(wav)
                self.assertEqual(result.status, "invalid")
                self.assertIn("LAB changed", result.reason)
            self.assertEqual(lab_checks, 2)

            orig_read = module._read_regular_lab

            def replace_wav(path):
                result = orig_read(path)
                make_wav(wav, samples=1001)
                return result

            with patch.object(module, "_read_regular_lab", side_effect=replace_wav):
                self.assertIn("WAV changed during", inspect_adjacent_lab(wav).reason)

    def test_wav_symlink_directory_and_fifo_are_rejected_without_reading(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wav = root / "speech.wav"
            make_wav(root / "regular.wav")
            wav.mkdir()
            try:
                result = inspect_adjacent_lab(wav)
                self.assertEqual(result.status, "invalid")
                # os.fdopen may reject directory descriptors before fstat;
                # both paths must fail safely without reading contents.
                self.assertTrue(result.reason)
            finally:
                wav.rmdir()
            try:
                wav.symlink_to(root / "regular.wav")
            except (OSError, NotImplementedError):
                pass
            else:
                self.assertEqual(inspect_adjacent_lab(wav).status, "invalid")
                wav.unlink()
            if hasattr(os, "mkfifo"):
                os.mkfifo(wav)
                try:
                    # No writer is connected. A blocking wave.open would hang.
                    result = inspect_adjacent_lab(wav)
                    self.assertEqual(result.status, "invalid")
                    self.assertIn("regular file", result.reason)
                finally:
                    wav.unlink()

    def test_wav_header_check_stays_on_open_inode_during_path_swap(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wav = root / "speech.wav"
            replacement = root / "replacement.wav"
            held = root / "held.wav"
            make_wav(wav)
            replacement.write_bytes(b"not a WAV")
            from tachie_motion.audio import lab as module
            original_validator = module.validate_pcm_header
            verified = False

            def swap_during_validation(path, *, stream, **kwargs):
                nonlocal verified
                self.assertEqual(path, wav)
                wav.rename(held)
                replacement.rename(wav)
                try:
                    # The new pathname is corrupt, but the existing descriptor
                    # must still validate the original well-formed PCM header.
                    original_validator(path, stream=stream, **kwargs)
                    verified = True
                finally:
                    wav.rename(replacement)
                    held.rename(wav)

            with patch.object(module, "validate_pcm_header", side_effect=swap_during_validation):
                result = inspect_adjacent_lab(wav)
            self.assertTrue(verified)
            # Pathname swaps may alter ctime; safe rejection is also valid.
            self.assertIn(result.status, ("missing", "invalid"))

    def test_input_limits_and_no_fallback(self):
        for sample_count, rate in ((0, 1000), (1, 0), (1.0, 1000), (1, "48000")):
            with self.subTest(sample_count=sample_count, rate=rate):
                with self.assertRaisesRegex(ValueError, "positive integer"):
                    parse_lab("0 1 a", samples=sample_count, sample_rate=rate)
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "voice.WAV"
            make_wav(wav)
            self.assertEqual(inspect_adjacent_lab(wav).status, "missing")
            wav.with_suffix(".lab").write_text("0 10000000 unknown\n", encoding="utf-8")
            result = inspect_adjacent_lab(wav)
            self.assertEqual(result.status, "invalid")
            self.assertFalse(result.intervals)


if __name__ == "__main__":
    unittest.main()
