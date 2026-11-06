"""Small, license-free tests of native OTIO structure and precise timing."""

from fractions import Fraction
import json
from pathlib import Path
import tempfile
import unittest

from tachie_motion.timeline.media import MovieTiming, WaveTiming, probe_wav
from tachie_motion.timeline.otio_json import build_single_utterance, write_otio
from tachie_motion.timeline.test_tone import make_test_tone


class OtioPocTests(unittest.TestCase):
    def test_one_audio_one_video_aligned_and_round_tripped_json(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            mov, wav, output = (
                folder / "立ち絵.mov",
                folder / "合成音声.wav",
                folder / "timeline.otio",
            )
            mov.touch()
            make_test_tone(wav, duration=Fraction(1, 1))
            audio = probe_wav(wav)
            self.assertEqual(audio, WaveTiming(48000, 48000))
            doc = build_single_utterance(
                mov, wav, MovieTiming(30, 30), audio
            )
            write_otio(doc, output)

            restored = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(restored["OTIO_SCHEMA"], "Timeline.1")
            stack = restored["tracks"]
            self.assertEqual(stack["OTIO_SCHEMA"], "Stack.1")
            tracks = stack["children"]
            self.assertEqual([t["kind"] for t in tracks], ["Video", "Audio"])
            self.assertEqual([len(t["children"]) for t in tracks], [1, 1])

            video, audio_clip = (t["children"][0] for t in tracks)
            self.assertEqual(video["OTIO_SCHEMA"], "Clip.2")
            self.assertEqual(audio_clip["OTIO_SCHEMA"], "Clip.2")
            self.assertEqual(
                video["source_range"]["duration"],
                {
                    "OTIO_SCHEMA": "RationalTime.1",
                    "value": 30,
                    "rate": 30,
                },
            )
            self.assertEqual(
                audio_clip["source_range"]["duration"],
                {
                    "OTIO_SCHEMA": "RationalTime.1",
                    "value": 48000,
                    "rate": 48000,
                },
            )
            for clip, expected_path in ((video, mov), (audio_clip, wav)):
                self.assertEqual(
                    clip["source_range"]["start_time"]["value"], 0
                )
                self.assertEqual(
                    clip["active_media_reference_key"], "DEFAULT_MEDIA"
                )
                self.assertEqual(
                    clip["media_references"]["DEFAULT_MEDIA"]["target_url"],
                    expected_path.resolve(strict=True).as_uri(),
                )
            self.assertEqual(
                output.read_text(encoding="utf-8").count(
                    '"OTIO_SCHEMA": "ExternalReference.1"'
                ), 2
            )
            self.assertNotIn("media_reference\":", output.read_text())

    def test_media_references_normalize_symlink_paths(self):
        # macOS tempfile paths may start with /var while realpath is
        # /private/var. Always compare and serialize canonical file URIs.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "real"
            real.mkdir()
            video = real / "video.mov"
            audio = real / "audio.wav"
            video.touch()
            make_test_tone(audio, duration=Fraction(1, 1))
            shortcut = root / "shortcut"
            try:
                shortcut.symlink_to(real, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("Creating a directory symlink is unavailable")

            doc = build_single_utterance(
                shortcut / "video.mov",
                shortcut / "audio.wav",
                MovieTiming(30, 30),
                WaveTiming(48000, 48000),
            )
            refs = [
                track["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"]
                for track in doc["tracks"]["children"]
            ]
            self.assertEqual(refs, [video.resolve().as_uri(), audio.resolve().as_uri()])

    def test_audio_must_match_movie_duration_exactly(self):
        with self.assertRaisesRegex(ValueError, "Duration mismatch"):
            build_single_utterance(
                Path("video.mov"),
                Path("audio.wav"),
                MovieTiming(30, 30),
                WaveTiming(47999, 48000),
            )

    def test_test_wav_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tone.wav"
            make_test_tone(path, duration=Fraction(1, 1))
            original = path.read_bytes()
            with self.assertRaises(FileExistsError):
                make_test_tone(path, duration=Fraction(1, 1))
            self.assertEqual(path.read_bytes(), original)

    def test_native_otio_file_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "timeline.otio"
            write_otio({"OTIO_SCHEMA": "Timeline.1"}, path)
            with self.assertRaises(FileExistsError):
                write_otio({"OTIO_SCHEMA": "Timeline.1"}, path)

    def test_wav_timing_preserves_fraction(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tone.wav"
            make_test_tone(path, duration=Fraction(1, 2))
            timing = probe_wav(path)
            self.assertEqual(timing.duration, Fraction(1, 2))
            self.assertEqual(timing.samples, 24000)


if __name__ == "__main__":
    unittest.main()
