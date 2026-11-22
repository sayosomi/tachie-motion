"""Combined PCM OTIO and single-file publication regressions (#18)."""
import json
import os
from pathlib import Path
from fractions import Fraction
import tempfile
import unittest
from unittest.mock import patch

from tachie_motion.timeline.media import MovieTiming, WaveTiming
from tachie_motion.timeline.otio_json import build_combined_segments, build_combined_utterances
from tachie_motion.web.combined_otio import create_combined_otio, probe_embedded_pcm, probe_no_embedded_audio
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
                                 str(mov.resolve()))
                self.assertEqual(a_clip["media_references"]["DEFAULT_MEDIA"]["target_url"],
                                 str(mov.resolve()))
                self.assertEqual(
                    v["media_references"]["DEFAULT_MEDIA"]["available_range"]["duration"]["value"],
                    timing.frames,
                )
            self.assertNotIn(".wav", json.dumps(result))
            self.assertIn("e\\u0301", json.dumps(result, ensure_ascii=True))

    def test_speech_idle_speech_uses_audio_gap_with_sample_accurate_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            first, idle, last = (
                folder / "発話_A.mov",
                folder / "待機_無音.mov",
                folder / "発話_B.mov",
            )
            for movie in (first, idle, last):
                movie.write_bytes(b"synthetic movie identity")
            entries = [
                (first, MovieTiming(31, 30), WaveTiming(48001, 48000)),
                (idle, MovieTiming(60, 30), None),
                (last, MovieTiming(30, 30), WaveTiming(48000, 48000)),
            ]
            timeline = build_combined_segments(entries)
            video, audio = timeline["tracks"]["children"]
            self.assertEqual([item["name"] for item in video["children"]],
                             ["Character MOV", "Idle MOV", "Character MOV"])
            self.assertEqual([item["OTIO_SCHEMA"] for item in audio["children"]],
                             ["Clip.2", "Gap.1", "Clip.2"])
            self.assertEqual(video["children"][1]["metadata"]["tachie_motion_segment"], "idle")
            self.assertNotIn("media_references", audio["children"][1])
            self.assertEqual(
                video["children"][1]["media_references"]["DEFAULT_MEDIA"]["target_url"],
                str(idle.resolve()))
            self.assertEqual(
                audio["children"][1]["source_range"]["duration"],
                {"OTIO_SCHEMA": "RationalTime.1", "value": 60, "rate": 30})
            for v, a in zip(video["children"], audio["children"]):
                self.assertEqual(v["source_range"]["duration"],
                                 a["source_range"]["duration"])
            duration = lambda item: Fraction(
                item["source_range"]["duration"]["value"],
                item["source_range"]["duration"]["rate"])
            self.assertEqual(sum(map(duration, video["children"]), Fraction(0)),
                             Fraction(48001, 48000) + 2 + 1)
            self.assertEqual(sum(map(duration, audio["children"]), Fraction(0)),
                             Fraction(48001, 48000) + 2 + 1)
            self.assertEqual(
                sum("media_references" in item for item in audio["children"]), 2)

    def test_idle_only_and_multiple_fps_gap_durations(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = Path(tmp) / "24fps.mov"
            b = Path(tmp) / "60fps.mov"
            a.write_bytes(b"a")
            b.write_bytes(b"b")
            result = build_combined_segments([
                (a, MovieTiming(48, 24), None),
                (b, MovieTiming(180, 60), None),
            ])
            video, audio = result["tracks"]["children"]
            self.assertEqual([c["OTIO_SCHEMA"] for c in audio["children"]],
                             ["Gap.1", "Gap.1"])
            self.assertEqual([(c["source_range"]["duration"]["value"],
                               c["source_range"]["duration"]["rate"])
                              for c in video["children"]], [(48, 24), (180, 60)])
            self.assertEqual([(c["source_range"]["duration"]["value"],
                               c["source_range"]["duration"]["rate"])
                              for c in audio["children"]], [(48, 24), (180, 60)])

    def test_idle_bad_frame_count_rejected_without_audio_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            mov = Path(tmp) / "idle.mov"
            mov.write_bytes(b"m")
            for frames, fps in ((0, 30), (-1, 30), (30, 25)):
                with self.subTest(frames=frames, fps=fps), self.assertRaises(ValueError):
                    build_combined_segments([(mov, MovieTiming(frames, fps), None)])

    def test_mixed_staged_otio_uses_final_paths_and_gap_without_audio_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage = root / "stage"
            public = root / "final"
            stage.mkdir()
            public.mkdir()
            speech, idle = "001_発話", "002_待機"
            for name in (speech, idle):
                (stage / (name + ".mov")).write_bytes(b"synthetic")
            entries = [
                {"basename": speech, "fps": 30, "frames": 31,
                 "samples": 48001, "sample_rate": 48000},
                {"kind": "idle", "basename": idle, "fps": 30, "frames": 60},
            ]
            with patch("tachie_motion.web.combined_otio.probe_movie",
                       side_effect=[MovieTiming(31, 30), MovieTiming(60, 30),
                                    MovieTiming(31, 30), MovieTiming(60, 30)]), patch(
                    "tachie_motion.web.combined_otio.probe_embedded_pcm",
                    return_value=WaveTiming(48001, 48000)), patch(
                    "tachie_motion.web.combined_otio.probe_no_embedded_audio",
                    return_value=None) as silent_probe:
                create_combined_otio(stage, "作品", entries, "error",
                                     reference_folder=public)
            document = json.loads((stage / "作品.otio").read_text(encoding="utf-8"))
            video, audio = document["tracks"]["children"]
            self.assertEqual([x["OTIO_SCHEMA"] for x in audio["children"]],
                             ["Clip.2", "Gap.1"])
            self.assertNotIn("media_references", audio["children"][1])
            self.assertEqual(
                video["children"][1]["media_references"]["DEFAULT_MEDIA"]["target_url"],
                str((public / (idle + ".mov")).absolute()))
            self.assertEqual(
                video["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"],
                str((public / (speech + ".mov")).absolute()))
            self.assertEqual(silent_probe.call_count, 2)
            self.assertEqual(audio["children"][1]["source_range"]["duration"],
                             video["children"][1]["source_range"]["duration"])

    def test_idle_audio_probe_rejects_embedded_pcm(self):
        class Result:
            returncode = 0
            stderr = b""
            stdout = b'{"streams":[]}'
        with tempfile.TemporaryDirectory() as tmp:
            mov = Path(tmp) / "silent.mov"
            mov.write_bytes(b"m")
            result = Result()
            with patch("tachie_motion.web.combined_otio.subprocess.run", return_value=result):
                self.assertIsNone(probe_no_embedded_audio(mov))
                result.stdout = b'{"streams":[{"index":1}]}'
                with self.assertRaisesRegex(ValueError, "no audio"):
                    probe_no_embedded_audio(mov)
                result.stdout = b"{}"
                with self.assertRaisesRegex(ValueError, "Invalid idle MOV"):
                    probe_no_embedded_audio(mov)

    def test_mixed_timeline_rejects_unknown_kind_idle_pcm_history_and_bad_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            mov = folder / "idle.mov"
            mov.write_bytes(b"synthetic")
            sample = {"kind": "idle", "basename": "idle", "fps": 30, "frames": 30}
            for bad in (
                {**sample, "kind": "unknown"},
                {**sample, "samples": 48000},
                {**sample, "sample_rate": 48000},
            ):
                with self.assertRaises(ValueError):
                    create_combined_otio(folder, "作品", [bad], "error")
            with self.assertRaisesRegex(ValueError, "history"):
                create_combined_otio(folder, "作品", [sample], "error",
                                     generation_history={"untrusted": True})
            with patch("tachie_motion.web.combined_otio.probe_movie",
                       return_value=MovieTiming(30, 30)), patch(
                    "tachie_motion.web.combined_otio.probe_no_embedded_audio",
                    side_effect=ValueError("Idle MOV must contain no audio streams")):
                with self.assertRaisesRegex(ValueError, "no audio"):
                    create_combined_otio(folder, "作品", [sample], "error")
            self.assertFalse((folder / "作品.otio").exists())
            self.assertEqual(mov.read_bytes(), b"synthetic")

    def test_staged_otio_references_final_plain_paths_on_both_tracks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage = root / ".tachie-batch-stage-test"
            stage.mkdir()
            public = root / "公開 space"
            public.mkdir()
            names = ["001_あんこもん_e\u0301", "002_space name"]
            entries = []
            for index, name in enumerate(names):
                (stage / (name + ".mov")).write_bytes(b"synthetic-only")
                entries.append({
                    "basename": name, "fps": 30, "frames": 31 if index == 0 else 30,
                    "samples": 48001 if index == 0 else 48000, "sample_rate": 48000,
                })
            def movie_timing(path):
                return MovieTiming(31 if path.stem == names[0] else 30, 30)
            def pcm_timing(path):
                return WaveTiming(48001 if path.stem == names[0] else 48000, 48000)
            with patch("tachie_motion.web.combined_otio.probe_movie",
                       side_effect=movie_timing), patch(
                       "tachie_motion.web.combined_otio.probe_embedded_pcm",
                       side_effect=pcm_timing):
                create_combined_otio(
                    stage, "timeline", entries, "error", reference_folder=public,
                )
            document = json.loads((stage / "timeline.otio").read_text(encoding="utf-8"))
            for track in document["tracks"]["children"]:
                self.assertEqual(len(track["children"]), len(names))
                for index, clip in enumerate(track["children"]):
                    ref = clip["media_references"]["DEFAULT_MEDIA"]["target_url"]
                    self.assertEqual(ref, str((public / (names[index] + ".mov")).absolute()))
                    self.assertNotIn(str(stage), ref)
                    self.assertFalse(ref.startswith("file://"))
            for track in document["tracks"]["children"]:
                self.assertEqual(
                    [clip["source_range"]["duration"] for clip in track["children"]],
                    [
                        {"OTIO_SCHEMA": "RationalTime.1", "value": 48001, "rate": 48000},
                        {"OTIO_SCHEMA": "RationalTime.1", "value": 48000, "rate": 48000},
                    ],
                )
            self.assertEqual(
                document["tracks"]["children"][0]["children"][0]
                ["media_references"]["DEFAULT_MEDIA"]["available_range"]["duration"],
                {"OTIO_SCHEMA": "RationalTime.1", "value": 31, "rate": 30},
            )

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


    def test_real_ffmpeg_silent_idle_has_no_audio_and_pcm_is_rejected(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            silent = Path(tmp) / "idle_透過.mov"
            speech = Path(tmp) / "speech_pcm.mov"
            base = [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=red:s=32x32:d=1:r=30",
            ]
            result = subprocess.run([
                *base, "-c:v", "prores_ks", "-profile:v", "4",
                "-frames:v", "30", "-an", str(silent),
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIsNone(probe_no_embedded_audio(silent))
            result = subprocess.run([
                *base, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
                "-c:v", "prores_ks", "-profile:v", "4",
                "-c:a", "pcm_s16le", "-frames:v", "30", "-t", "1",
                str(speech),
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with self.assertRaisesRegex(ValueError, "no audio"):
                probe_no_embedded_audio(speech)

    def test_probe_real_ffmpeg_pcm_mov_sample_count(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            movie = Path(tmp) / "test.mov"
            run = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=red:s=32x32:d=1:r=30",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
                "-c:v", "prores_ks", "-profile:v", "4",
                "-c:a", "pcm_s16le", "-frames:v", "30", "-t", "1",
                str(movie),
            ], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(probe_embedded_pcm(movie), WaveTiming(48000, 48000))


    def test_batch_mov_and_combined_otio_cannot_overwrite_one_half_of_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            mov = folder / "existing.mov"
            otio = folder / "existing.otio"
            mov.write_bytes(b"MOV")
            otio.write_bytes(b"OTIO")
            self.assertEqual(single_destination(mov)["state"], "unsafe")
            self.assertEqual(single_destination(otio)["state"], "unsafe")
            with self.assertRaisesRegex(ValueError, "pair"):
                initial_single_identity(mov, "overwrite")
            with self.assertRaisesRegex(ValueError, "pair"):
                initial_single_identity(otio, "overwrite")
            self.assertEqual(mov.read_bytes(), b"MOV")
            self.assertEqual(otio.read_bytes(), b"OTIO")


if __name__ == "__main__":
    unittest.main()
