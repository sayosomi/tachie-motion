"""Focused synthetic regression tests for D31's safe public-name reuse."""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import os
import unittest

from tachie_motion.web.selective_reuse import (
    SavedMovie, NamingCandidate, encode_history, decode_history,
    verify_published_movie, select_public_names,
)
from tachie_motion.web.selective_recipe import digest_regular_file


def record(item: str, basename: str, content: bytes = b"media") -> SavedMovie:
    import hashlib
    return SavedMovie(
        item_id=item, basename=basename, recipe_sha256="a" * 64,
        mov_sha256=hashlib.sha256(content).hexdigest(),
        frames=30, fps=30, samples=48000, sample_rate=48000,
    )


class SelectiveReuseTests(unittest.TestCase):
    def test_history_roundtrip_and_rejects_duplicates(self):
        entries = [record("a", "001_A"), record("b", "002_B")]
        self.assertEqual(decode_history(encode_history(entries)), {e.item_id: e for e in entries})
        with self.assertRaises(ValueError):
            encode_history([entries[0], record("a", "003_C")])
        with self.assertRaises(ValueError):
            encode_history([entries[0], record("c", "001_a")])
        with self.assertRaises(ValueError):
            decode_history({"format": "unknown", "entries": [entries[0].__dict__]})
        with self.assertRaises(ValueError):
            decode_history({"format": "tachie-motion-selective-history-v1",
                            "entries": [{**entries[0].__dict__, "surprise": 1}]})

    def test_reorder_keeps_all_published_names(self):
        a, b, c = (record("a", "001_A"), record("b", "002_B"), record("c", "003_C"))
        plan = select_public_names([
            NamingCandidate("c", "001_C", c, True),
            NamingCandidate("a", "002_A", a, True),
            NamingCandidate("b", "003_B", b, True),
        ], "project")
        self.assertEqual([(x.basename, x.reuse) for x in plan],
                         [("003_C", True), ("001_A", True), ("002_B", True)])

    def test_dirty_reencodes_without_renaming_a_verified_neighbor(self):
        a, b = record("a", "001_A"), record("b", "002_B")
        plan = select_public_names([
            NamingCandidate("b", "001_B-new", b, False),
            NamingCandidate("a", "002_A", a, True),
        ], "project")
        self.assertEqual([(x.basename, x.reuse) for x in plan],
                         [("001_B-new", False), ("001_A", True)])

    def test_dirty_name_collision_with_retained_file_is_rejected(self):
        a, b = record("a", "001_A"), record("b", "002_B")
        with self.assertRaisesRegex(ValueError, "collision"):
            select_public_names([
                NamingCandidate("a", "001_A", a, True),
                NamingCandidate("b", "001_a", b, False),
            ], "project")

    def test_manual_override_is_not_silently_discarded(self):
        a = record("a", "001_A")
        plan = select_public_names([
            NamingCandidate("a", "manual_name", a, True, manually_named=True),
        ], "project")
        self.assertEqual(plan[0].basename, "manual_name")
        self.assertFalse(plan[0].reuse)

    def test_duplicate_ids_and_invalid_history_cannot_authorize_reuse(self):
        a = record("a", "001_A")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            select_public_names([
                NamingCandidate("a", "001_A", a, True),
                NamingCandidate("a", "002_A", a, False),
            ], "project")
        with self.assertRaisesRegex(ValueError, "without"):
            select_public_names([NamingCandidate("b", "001_B", None, True)], "project")

    def test_existing_movie_hash_and_media_timing(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            movie = folder / "001_A.mov"
            movie.write_bytes(b"media")
            saved = record("a", "001_A")
            video = lambda _: SimpleNamespace(frames=30, fps=30)
            audio = lambda _: SimpleNamespace(samples=48000, sample_rate=48000)
            args = dict(folder=folder, saved=saved, item_id="a",
                        recipe_sha256="a" * 64, fps=30,
                        samples=48000, sample_rate=48000,
                        video_probe=video, audio_probe=audio)
            self.assertTrue(verify_published_movie(**args))
            self.assertFalse(verify_published_movie(**{**args, "recipe_sha256": "b" * 64}))
            self.assertFalse(verify_published_movie(
                **{**args, "audio_probe": lambda _: SimpleNamespace(
                    samples=48001, sample_rate=48000)}))
            original_mtime = movie.stat().st_mtime_ns
            movie.write_bytes(b"MEDia")
            os.utime(movie, ns=(original_mtime, original_mtime))
            self.assertEqual(movie.stat().st_size, len(b"media"))
            self.assertNotEqual(digest_regular_file(movie).sha256, saved.mov_sha256)
            self.assertFalse(verify_published_movie(**args))

    def test_symlink_and_missing_mov_are_never_reused(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            target = folder / "original"
            target.write_bytes(b"media")
            link = folder / "001_A.mov"
            link.symlink_to(target)
            kw = dict(folder=folder, saved=record("a", "001_A"), item_id="a",
                      recipe_sha256="a" * 64, fps=30,
                      samples=48000, sample_rate=48000,
                      video_probe=lambda _: SimpleNamespace(frames=30, fps=30),
                      audio_probe=lambda _: SimpleNamespace(samples=48000, sample_rate=48000))
            self.assertFalse(verify_published_movie(**kw))
            link.unlink()
            self.assertFalse(verify_published_movie(**kw))


if __name__ == "__main__":
    unittest.main()
