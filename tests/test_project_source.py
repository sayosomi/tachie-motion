"""Project-file source identity: WAV changes must not be silently accepted.

These tests intentionally use unittest because the GitHub CI discovers Python
tests with unittest, without installing the optional pytest runner.
"""

import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from tachie_motion.web import service


def wav_fixture(directory: Path) -> Path:
    path = directory / "音声 e\u0301.wav"
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(48000)
        writer.writeframes(b"\x00\x00" * 480)
    return path


class ProjectSourceTests(unittest.TestCase):
    def test_describe_wav_has_full_source_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = wav_fixture(Path(tmp))
            info = service.describe_wav(str(path))
            self.assertEqual(info["samples"], 480)
            self.assertEqual(info["sample_rate"], 48000)
            self.assertEqual(len(info["source_identity"].split(":")), 5)
            self.assertEqual(info["source_identity"], ":".join(
                map(str, service.file_identity(path))
            ))
            self.assertEqual(
                service.describe_wav(str(path))["source_identity"], info["source_identity"]
            )

    def test_changed_source_during_wav_inspection_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = wav_fixture(Path(tmp))
            first = (1, 2, 3, 4, 5)
            second = (1, 2, 4, 4, 5)
            with patch.object(service, "file_identity", side_effect=[first, second]):
                with self.assertRaisesRegex(ValueError, "changed during inspection"):
                    service.describe_wav(str(path))


if __name__ == "__main__":
    unittest.main()
