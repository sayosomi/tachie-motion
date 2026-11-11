"""Combined PCM OTIO and single-file publication regressions (#18)."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tachie_motion.timeline.media import MovieTiming, WaveTiming
from tachie_motion.timeline.otio_json import build_combined_utterances
from tachie_motion.web.combined_otio import create_combined_otio, probe_embedded_pcm
from tachie_motion.web.solo_output import (
    initial_single_identity, publish_single, single_destination, validate_media_basename,
)


class CombinedOtioTests(unittest.TestCase):
    def test_audio_sample_timing_matches_video_and_reuses_same_mov(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            a = folder / "001_あんこもん_最初.mov"
            b = folder / "002_あんこもん_e\u0301.mov"
            for path in (a, b):
                path.write_bytes(b"synthetic-only")
            entries = [
                (a, MovieTiming(31, 30), WaveTiming(48001, 48000)),
                (b, MovieTiming(30, 30), WaveTiming(48000, 48000)),
            ]
            result = build_combined_utterances(entries)
            video, audio = result["tracks"]["children"]
            self.assertEqual([c["name"] for c in video["children"]],
                             ["Character MOV", "Character MOV"])
            self.assertEqual(len(audio["children"]), 2)
            for i, (mov, timing, samples) in enumerate(entries):
                v = video["children"][i]
                a_clip = audio["children"][i]
                v_duration = v["source_range"]["duration"]
                a_duration = a_clip["source_range"]["duration"]
                self.assertEqual(v_duration, a_duration)
                self.assertEqual(v_duration["value"], samples.samples)
                self.assertEqual(v_duration["rate"], samples.sample_rate)
                self.assertEqual(v["media_references"]["DEFAULT_MEDIA"]["target_url"],
                                 mov.resolve().as_uri())
                self.assertEqual(a_clip["media_references"]["DEFAULT_MEDIA"]["target_url"],
                                 str(mov.resolve()))
                self.assertEqual(
                    v["media_references"]["DEFAULT_MEDIA"]["available_range"]["duration"]["value"],
                    timing.frames,
                )
            self.assertNotIn(".wav", json.dumps(result))
            self.assertIn("e\\u0301", json.dumps(result, ensure_ascii=True))

    def test_rounding_and_missing_entries_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            mov = Path(tmp) / "item.mov"
            mov.write_bytes(b"m")
            with self.assertRaises(ValueError):
                build_combined_utterances([])
            with self.assertRaisesRegex(ValueError, "frame count"):
                build_combined_utterances([
                    (mov, MovieTiming(30, 30), WaveTiming(48001, 48000))])

    def test_combined_file_is_one_otio_and_references_existing_movies(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            first = folder / "001_あんこもん_最初.mov"
            second = folder / "002_あんこもん_次.mov"
            first.write_bytes(b"movie1")
            second.write_bytes(b"movie2")
            entries = [{"basename": item.stem, "fps": 30, "frames": 30,
                        "samples": 48000, "sample_rate": 48000} for item in (first, second)]
            with patch("tachie_motion.web.combined_otio.probe_movie",
                       return_value=MovieTiming(30, 30)), patch(
                       "tachie_motion.web.combined_otio.probe_embedded_pcm",
                       return_value=WaveTiming(48000, 48000)):
                result = create_combined_otio(folder, "作品", entries, "error")
            self.assertEqual(result["entries"], 2)
            self.assertEqual(Path(result["otio"]), folder / "作品.otio")
            doc = json.loads((folder / "作品.otio").read_text(encoding="utf-8"))
            self.assertEqual(len(doc["tracks"]["children"][0]["children"]), 2)
            self.assertEqual(len(list(folder.glob("*.otio"))), 1)
            with self.assertRaises(FileExistsError):
                create_combined_otio(folder, "作品", entries, "error")

    def test_conflict_and_symlink_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            stage = folder / "stage.mov"
            target = folder / "001.mov"
            stage.write_bytes(b"NEW")
            self.assertEqual(single_destination(target)["state"], "available")
            self.assertIsNone(initial_single_identity(target, "error"))
            publish_single(stage, target, policy="error", prior=None)
            self.assertEqual(target.read_bytes(), b"NEW")
            prior = initial_single_identity(target, "overwrite")
            target.write_bytes(b"CHANGED")
            with self.assertRaises(FileExistsError):
                publish_single(stage, target, policy="overwrite", prior=prior)
            self.assertEqual(target.read_bytes(), b"CHANGED")
            prior = initial_single_identity(target, "overwrite")
            replacement = folder / "replacement.mov"
            replacement.write_bytes(b"NEW-VERSION")
            publish_single(replacement, target, policy="overwrite", prior=prior)
            self.assertEqual(target.read_bytes(), b"NEW-VERSION")
            self.assertFalse((folder / ".001.mov.single-backup").exists())
            symlink = folder / "symlink.mov"
            symlink.symlink_to(target)
            self.assertEqual(single_destination(symlink)["state"], "unsafe")
            with self.assertRaises(ValueError):
                initial_single_identity(symlink, "overwrite")

    def test_nfd_and_unsafe_media_names(self):
        self.assertEqual(validate_media_basename("001_あんこもん_e\u0301"),
                         "001_あんこもん_e\u0301")
        for value in ("", "../escape", "dir/name", "abc\\x00", "CON", ".hidden",
                      "bad?", "name.", "name ", "a" * 200):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_media_basename(value)

    def test_invalid_pcm_probe_fails_safe(self):
        class Result:
            returncode = 0
            stderr = b""
        with tempfile.TemporaryDirectory() as tmp:
            movie = Path(tmp) / "clip.mov"
            movie.write_bytes(b"")
            result = Result()
            result.stdout = json.dumps({
                "streams": [{"codec_name": "pcm_s16le", "sample_rate": "48000",
                             "duration_ts": 48000, "time_base": "1/48000"}],
            }).encode()
            with patch("tachie_motion.web.combined_otio.subprocess.run", return_value=result):
                self.assertEqual(probe_embedded_pcm(movie), WaveTiming(48000, 48000))
            result.stdout = json.dumps({"streams": [
                {"codec_name": "aac", "sample_rate": "48000",
                 "duration_ts": 48000, "time_base": "1/48000"},
            ]}).encode()
            with patch("tachie_motion.web.combined_otio.subprocess.run", return_value=result):
                with self.assertRaises(ValueError):
                    probe_embedded_pcm(movie)


if __name__ == "__main__":
    unittest.main()
