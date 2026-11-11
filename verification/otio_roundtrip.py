"""Official OpenTimelineIO 0.18.1 deserialize/serialize validation.

Run under Python 3.13 with the official package installed. The core project
still supports Python 3.14 without making this binary dependency mandatory.
"""

from fractions import Fraction
import json
from pathlib import Path
import tempfile
import unittest

import opentimelineio as otio

from tachie_motion.timeline.media import MovieTiming, WaveTiming
from tachie_motion.timeline.otio_json import build_single_utterance, write_otio


class OfficialOtioRoundtrip(unittest.TestCase):
    def test_native_otio_deserializes_and_preserves_tracks_urls_and_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            mov, wav, path = (
                folder / "animation.mov",
                folder / "voice.wav",
                folder / "timeline.otio",
            )
            # Files need to exist to form canonical file URIs; this test
            # validates JSON data, not video/audio media decoding.
            mov.touch()
            wav.touch()
            expected_movie = MovieTiming(30, 30)
            expected_audio = WaveTiming(48000, 48000)
            write_otio(
                build_single_utterance(
                    mov, wav, expected_movie, expected_audio
                ),
                path,
            )

            parsed = otio.adapters.read_from_file(str(path))
            self.assertIsInstance(parsed, otio.schema.Timeline)
            self.assertEqual(len(parsed.tracks), 2)
            kinds = [t.kind for t in parsed.tracks]
            self.assertEqual(
                kinds, [otio.schema.TrackKind.Video, otio.schema.TrackKind.Audio]
            )
            expected = [(mov.resolve().as_uri(), 30, 30),
                        (wav.resolve().as_uri(), 48000, 48000)]
            for track, (uri, units, rate) in zip(
                parsed.tracks, expected, strict=True
            ):
                self.assertEqual(len(track), 1)
                clip = track[0]
                self.assertIsInstance(clip, otio.schema.Clip)
                self.assertEqual(clip.media_reference.target_url, uri)
                self.assertEqual(clip.source_range.start_time.value, 0)
                self.assertEqual(clip.source_range.duration.value, units)
                self.assertEqual(clip.source_range.duration.rate, rate)

            serialized = otio.adapters.write_to_string(parsed, "otio_json")
            reparsed = otio.adapters.read_from_string(serialized, "otio_json")
            self.assertIsInstance(reparsed, otio.schema.Timeline)
            self.assertEqual(len(reparsed.tracks), 2)
            self.assertEqual(
                [track.kind for track in reparsed.tracks],
                [otio.schema.TrackKind.Video, otio.schema.TrackKind.Audio],
            )
            for track, (uri, units, rate) in zip(
                reparsed.tracks, expected, strict=True
            ):
                clip = track[0]
                self.assertEqual(clip.media_reference.target_url, uri)
                self.assertEqual(clip.source_range.start_time.value, 0)
                self.assertEqual(clip.source_range.duration.value, units)
                self.assertEqual(clip.source_range.duration.rate, rate)
            self.assertEqual(
                Fraction(
                    int(reparsed.tracks[0][0].source_range.duration.value),
                    int(reparsed.tracks[0][0].source_range.duration.rate),
                ),
                Fraction(1),
            )
            # Verify the official serializer produced valid schema-bearing JSON.
            self.assertEqual(json.loads(serialized)["OTIO_SCHEMA"], "Timeline.1")


    def test_rounded_video_and_sample_exact_audio_roundtrip(self):
        from tachie_motion.timeline.otio_json import build_rounded_utterance
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            mov = root / "partial.mov"
            wav = root / "日本語 た\u3099音.wav"
            mov.touch()
            wav.touch()
            document = build_rounded_utterance(
                mov, wav, MovieTiming(4, 30), WaveTiming(101, 1000)
            )
            location = root / "partial.otio"
            write_otio(document, location)
            timeline = otio.adapters.read_from_file(str(location))
            self.assertEqual(len(timeline.tracks), 2)
            self.assertEqual(
                (
                    timeline.tracks[0][0].source_range.duration.value,
                    timeline.tracks[0][0].source_range.duration.rate,
                ), (4, 30),
            )
            self.assertEqual(
                (
                    timeline.tracks[1][0].source_range.duration.value,
                    timeline.tracks[1][0].source_range.duration.rate,
                ), (101, 1000),
            )
            self.assertEqual(
                timeline.tracks[0][0].source_range.start_time.value, 0,
            )
            self.assertEqual(
                timeline.tracks[1][0].source_range.start_time.value, 0,
            )
            self.assertEqual(
                timeline.tracks[1][0].media_reference.target_url,
                str(wav.resolve()),
            )
            self.assertEqual(
                timeline.tracks[0][0].media_reference.target_url,
                mov.resolve().as_uri(),
            )
            self.assertEqual(set(root.iterdir()), {mov, wav, location})
            roundtrip = otio.adapters.read_from_string(
                otio.adapters.write_to_string(timeline, "otio_json"),
                "otio_json",
            )
            self.assertEqual(len(roundtrip.tracks), 2)
            self.assertEqual(
                roundtrip.tracks[1][0].source_range.duration.value, 101
            )
            self.assertEqual(
                roundtrip.tracks[1][0].media_reference.target_url,
                str(wav.resolve()),
            )

    def test_embedded_pcm_audio_reference_roundtrip_without_wav_link(self):
        from tachie_motion.timeline.otio_json import build_rounded_utterance
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            mov = root / "透過-animation.mov"
            wav = root / "元 音声た\u3099.wav"
            mov.touch()
            wav.touch()
            document = build_rounded_utterance(
                mov, wav, MovieTiming(4, 30), WaveTiming(101, 1000),
                embedded_audio=True,
            )
            path = root / "embedded.otio"
            write_otio(document, path)
            timeline = otio.adapters.read_from_file(str(path))
            self.assertEqual(len(timeline.tracks), 2)
            video, audio = timeline.tracks[0][0], timeline.tracks[1][0]
            self.assertEqual(video.media_reference.target_url, mov.resolve().as_uri())
            self.assertEqual(audio.media_reference.target_url, str(mov.resolve()))
            self.assertEqual(
                (audio.source_range.duration.value, audio.source_range.duration.rate),
                (101, 1000),
            )
            self.assertNotIn(str(wav.resolve()), path.read_text(encoding="utf-8"))
            serialized = otio.adapters.write_to_string(timeline, "otio_json")
            reparsed = otio.adapters.read_from_string(serialized, "otio_json")
            self.assertEqual(reparsed.tracks[1][0].media_reference.target_url, str(mov.resolve()))


    def test_combined_timeline_roundtrip_keeps_order_and_sample_boundaries(self):
        from tachie_motion.timeline.otio_json import build_combined_utterances
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "001_あんこもん_最初.mov"
            second = root / "002_ずんだもん_e\u0301.mov"
            first.touch()
            second.touch()
            combined = build_combined_utterances([
                (first, MovieTiming(31, 30), WaveTiming(48001, 48000)),
                (second, MovieTiming(30, 30), WaveTiming(48000, 48000)),
            ])
            file = root / "作品.otio"
            write_otio(combined, file)
            result = otio.adapters.read_from_file(str(file))
            self.assertEqual(len(result.tracks), 2)
            self.assertEqual([track.kind for track in result.tracks],
                             [otio.schema.TrackKind.Video, otio.schema.TrackKind.Audio])
            for track in result.tracks:
                self.assertEqual(len(track), 2)
                self.assertEqual(
                    [clip.source_range.duration.value for clip in track],
                    [48001, 48000],
                )
                self.assertEqual(
                    [clip.source_range.duration.rate for clip in track],
                    [48000, 48000],
                )
                self.assertAlmostEqual(track[1].range_in_parent().start_time.to_seconds(),
                                       48001 / 48000, places=6)
            for i, mov in enumerate((first, second)):
                self.assertEqual(
                    result.tracks[0][i].media_reference.target_url,
                    mov.resolve().as_uri(),
                )
                self.assertEqual(
                    result.tracks[1][i].media_reference.target_url,
                    str(mov.resolve()),
                )
            encoded = otio.adapters.write_to_string(result, "otio_json")
            decoded = otio.adapters.read_from_string(encoded, "otio_json")
            self.assertEqual(len(decoded.tracks[1]), 2)
            self.assertEqual(
                decoded.tracks[1][1].media_reference.target_url,
                str(second.resolve()),
            )


if __name__ == "__main__":
    unittest.main()
