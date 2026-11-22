"""Contract tests for server-side source capture and OTIO generation metadata."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from fractions import Fraction
import hashlib
import json
import unittest

from tachie_motion.timeline.media import MovieTiming, WaveTiming
from tachie_motion.web.combined_otio import create_combined_otio
from tachie_motion.web.selective_history import capture_recipe_sources, render_recipe
from tachie_motion.web.selective_reuse import SavedMovie, encode_history


class CaptureHistoryTests(unittest.TestCase):
    def test_render_recipe_is_order_independent_but_source_sensitive(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            psd = folder / "char.psd"
            wav = folder / "speech.wav"
            psd.write_bytes(b"source psd")
            wav.write_bytes(b"source wav")
            payload = {
                "psd": str(psd), "wav": str(wav), "fingerprint": "identity",
                "source_identity": "registered", "layers": [], "mode": "none",
                "blink_enabled": False, "fps": 30,
            }
            base = capture_recipe_sources(payload)
            first = render_recipe(payload, base)
            self.assertEqual(first, render_recipe(
                {**payload, "basename": "001_speech", "output_dir": str(folder),
                 "batch_index": 9, "batch_id": "random"}, base))
            wav.write_bytes(b"source changed")
            self.assertNotEqual(base, capture_recipe_sources(payload))
            self.assertNotEqual(first, render_recipe(
                payload, capture_recipe_sources(payload)))

    def test_lab_is_used_only_for_aiueo(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            psd, wav = folder / "char.psd", folder / "speech.wav"
            psd.write_bytes(b"psd")
            wav.write_bytes(b"wav")
            payload = {"psd": str(psd), "wav": str(wav),
                       "fingerprint": "source", "source_identity": "id",
                       "layers": [], "fps": 30, "blink_enabled": False,
                       "mode": "none"}
            self.assertIsNone(capture_recipe_sources(payload)[2])
            with self.assertRaises(FileNotFoundError):
                capture_recipe_sources({**payload, "mode": "aiueo"})
            lab = folder / "speech.lab"
            lab.write_bytes(b"0 10000 a\n")
            self.assertIsNotNone(capture_recipe_sources({**payload, "mode": "aiueo"})[2])


class OtioMetadataTests(unittest.TestCase):
    def create(self, folder, history=None):
        movie = folder / "001_speech.mov"
        movie.write_bytes(b"fake mov")
        entries = [{"basename": "001_speech", "frames": 30, "fps": 30,
                    "samples": 48000, "sample_rate": 48000}]
        with patch("tachie_motion.web.combined_otio.probe_movie",
                   return_value=MovieTiming(30, 30)), patch(
                   "tachie_motion.web.combined_otio.probe_embedded_pcm",
                   return_value=WaveTiming(48000, 48000)):
            create_combined_otio(folder, "project", entries, "error",
                                 generation_history=history)
        return json.loads((folder / "project.otio").read_text(encoding="utf-8"))

    def test_generated_otio_carries_exact_history(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            history = encode_history([SavedMovie(
                item_id="utterance-1", basename="001_speech",
                recipe_sha256="a" * 64,
                mov_sha256=hashlib.sha256(b"fake mov").hexdigest(),
                frames=30, fps=30, samples=48000, sample_rate=48000,
            )])
            doc = self.create(folder, history)
            self.assertEqual(doc["metadata"]["tachie_motion_selective"], history)
            self.assertEqual(len(doc["tracks"]["children"]), 2)

    def test_legacy_otio_has_no_generation_metadata(self):
        with TemporaryDirectory() as temp:
            doc = self.create(Path(temp))
            self.assertNotIn("tachie_motion_selective", doc["metadata"])

    def test_incomplete_history_cannot_be_published(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            movie = folder / "001_speech.mov"
            movie.write_bytes(b"fake mov")
            entries = [{"basename": "001_speech", "frames": 30, "fps": 30,
                        "samples": 48000, "sample_rate": 48000}]
            history = encode_history([
                SavedMovie("a", "001_speech", "a" * 64, "b" * 64,
                           30, 30, 48000, 48000),
                SavedMovie("b", "002_speech", "a" * 64, "b" * 64,
                           30, 30, 48000, 48000),
            ])
            with patch("tachie_motion.web.combined_otio.probe_movie",
                       return_value=MovieTiming(30, 30)), patch(
                       "tachie_motion.web.combined_otio.probe_embedded_pcm",
                       return_value=WaveTiming(48000, 48000)):
                with self.assertRaisesRegex(ValueError, "Incomplete generation history"):
                    create_combined_otio(
                        folder, "project", entries, "error",
                        generation_history=history)
            self.assertFalse((folder / "project.otio").exists())


if __name__ == "__main__":
    unittest.main()
