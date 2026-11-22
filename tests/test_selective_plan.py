"""Reject forged, stale, mismatched or externally edited reuse history."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
import unittest

from tachie_motion.web.selective_plan import load_saved_movies, verified_reuse
from tachie_motion.web.selective_attestation import sign_timeline
from tachie_motion.web.selective_history import capture_recipe_sources, render_recipe
from tachie_motion.web.selective_reuse import SavedMovie, encode_history
from tachie_motion.web.selective_recipe import digest_regular_file


class SelectivePlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        key_path = patch(
            "tachie_motion.web.selective_attestation._key_path",
            return_value=self.root / ".private-auth" / "key")
        key_path.start()
        self.addCleanup(key_path.stop)
        self.psd = self.root / "character.psd"
        self.wav = self.root / "speech.wav"
        self.mov = self.root / "001_キャラ.mov"
        self.psd.write_bytes(b"psd")
        self.wav.write_bytes(b"wav")
        self.mov.write_bytes(b"mov")
        self.render = {
            "psd": str(self.psd), "wav": str(self.wav),
            "source_identity": "1:2:3:4:5", "fingerprint": "fp",
            "layers": [], "mode": "none", "blink_enabled": False, "fps": 30,
        }
        self.saved = SavedMovie(
            item_id="item-a", basename=self.mov.stem,
            recipe_sha256=render_recipe(self.render, capture_recipe_sources(self.render)),
            mov_sha256=digest_regular_file(self.mov).sha256,
            frames=30, fps=30, samples=48000, sample_rate=48000,
        )
        clips = []
        for track_kind in ("Video", "Audio"):
            clips.append({
                "kind": track_kind,
                "children": [{
                    "media_references": {"DEFAULT_MEDIA": {"target_url": str(self.mov)}},
                }],
            })
        self.timeline = {
            "OTIO_SCHEMA": "Timeline.1",
            "metadata": {"tachie_motion_selective": encode_history([self.saved])},
            "tracks": {"children": clips},
        }
        self.otio = self.root / "project.otio"
        sign_timeline(self.timeline)
        self.save()

    def save(self):
        self.otio.write_text(json.dumps(self.timeline), encoding="utf-8")

    def probe(self):
        return patch("tachie_motion.web.selective_plan.file_identity",
                     return_value=(1, 2, 3, 4, 5))

    def verify(self, valid_alpha=True, **kw):
        with self.probe(), patch(
            "tachie_motion.web.selective_plan.probe_wav",
            return_value=SimpleNamespace(samples=48000, sample_rate=48000)), patch(
            "tachie_motion.web.selective_plan.probe_movie",
            return_value=SimpleNamespace(frames=30, fps=30)), patch(
            "tachie_motion.web.selective_plan.probe_embedded_pcm",
            return_value=SimpleNamespace(samples=48000, sample_rate=48000)), patch(
            "tachie_motion.web.selective_plan.probe_alpha_prores",
            return_value=valid_alpha):
            return verified_reuse(self.root, "project", item_id="item-a",
                                  render={**self.render, "source_identity": "1:2:3:4:5"},
                                  **kw)

    def test_valid_otio_history_can_be_read(self):
        self.assertEqual(load_saved_movies(self.root, "project"), {"item-a": self.saved})

    def test_history_forgery_and_lost_key_fail_closed(self):
        self.assertIsNotNone(self.verify())
        valid = self.otio.read_bytes()
        self.timeline["metadata"]["tachie_motion_selective"]["entries"][0][
            "mov_sha256"] = "b" * 64
        self.save()  # Correctly shaped forged hash, unauthenticated.
        self.assertEqual(load_saved_movies(self.root, "project"), {})
        self.otio.write_bytes(valid)
        (self.root / ".private-auth" / "key").unlink()
        self.assertEqual(load_saved_movies(self.root, "project"), {})

    def test_non_prores_movie_never_reuses(self):
        self.assertIsNotNone(self.verify())
        self.assertIsNone(self.verify(valid_alpha=False))

    def test_wrong_track_reference_never_reuses(self):
        self.timeline["tracks"]["children"][1]["children"][0]["media_references"][
            "DEFAULT_MEDIA"]["target_url"] = str(self.wav)
        self.save()
        self.assertEqual(load_saved_movies(self.root, "project"), {})

    def test_corrupt_and_symlink_otio_do_not_grant_reuse(self):
        self.otio.write_text("{broken", encoding="utf-8")
        self.assertEqual(load_saved_movies(self.root, "project"), {})
        self.otio.unlink()
        self.otio.symlink_to(self.wav)
        self.assertEqual(load_saved_movies(self.root, "project"), {})

    def test_wrong_movie_hash_never_reuses(self):
        self.assertIsNotNone(self.verify())
        self.mov.write_bytes(b"changed MOV")
        self.assertIsNone(self.verify())

    def test_wrong_recipe_or_name_never_reuses(self):
        self.assertIsNone(self.verify(expected_basename="002_changed"))
        self.assertIsNone(self.verify(saved_movies={}))

    def test_changed_psd_or_wav_never_reuses(self):
        self.assertIsNotNone(self.verify())
        self.psd.write_bytes(b"changed")
        self.assertIsNone(self.verify())


if __name__ == "__main__":
    unittest.main()
