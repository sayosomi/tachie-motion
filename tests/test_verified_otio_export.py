"""Issue #6: no second decode scan for the same newly verified export."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from fractions import Fraction
from unittest.mock import patch

from PIL import Image, ImageDraw

from tachie_motion.timeline.media import MovieTiming, probe_movie
from tachie_motion.timeline.test_tone import make_test_tone
from tachie_motion.timeline.verified_export import export_verified_utterance


def _states(folder: Path) -> list[Path]:
    paths = [folder / "a.png", folder / "b.png"]
    for path, color in zip(paths, ((200, 60, 30, 255), (30, 60, 200, 255))):
        img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        ImageDraw.Draw(img).rectangle((5, 5, 26, 26), fill=color)
        img.save(path)
    return paths


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "FFmpeg and ffprobe required for real MOV integration",
)
class VerifiedExportIntegrationTests(unittest.TestCase):
    def test_verified_mov_and_otio_use_same_report_without_second_frame_probe(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            states = _states(root)
            wav = root / "voice.wav"
            make_test_tone(wav, duration=Fraction(1, 1))
            mov, otio = root / "new.mov", root / "timeline.otio"
            from tachie_motion.timeline import media
            with patch.object(
                media, "probe_movie",
                side_effect=AssertionError("unnecessary second frame-count scan")
            ) as unnecessary:
                report = export_verified_utterance(
                    states, mov=mov, wav=wav, otio=otio,
                    fps=30, frames_per_state=15
                )
            unnecessary.assert_not_called()
            self.assertEqual(report.frames, 30)
            self.assertEqual(report.decoded_frames, 30)
            self.assertEqual(report.pixel_format, "yuva444p12le")
            self.assertTrue(mov.is_file())
            self.assertTrue(otio.is_file())
            doc = json.loads(otio.read_text(encoding="utf-8"))
            tracks = doc["tracks"]["children"]
            self.assertEqual([t["kind"] for t in tracks], ["Video", "Audio"])
            self.assertEqual(
                tracks[0]["children"][0]["source_range"]["duration"],
                {"OTIO_SCHEMA": "RationalTime.1", "value": 30, "rate": 30}
            )
            self.assertEqual(
                tracks[1]["children"][0]["source_range"]["duration"],
                {"OTIO_SCHEMA": "RationalTime.1", "value": 48000, "rate": 48000}
            )
            self.assertEqual(
                [len(t["children"]) for t in tracks], [1, 1]
            )
            self.assertEqual(
                tracks[0]["children"][0]["media_references"]
                ["DEFAULT_MEDIA"]["target_url"],
                mov.resolve().as_uri()
            )

            # Even a just-generated MOV is an external input to this
            # independent API. A new process / a copied file is equally
            # unprivileged: the old decoded-frame count is still required.
            import tachie_motion.timeline.media as media
            real_run = subprocess.run
            with patch.object(media.subprocess, "run", wraps=real_run) as calls:
                self.assertEqual(probe_movie(mov), MovieTiming(30, 30))
            self.assertEqual(calls.call_count, 1)
            self.assertIn("-count_frames", calls.call_args.args[0])
            self.assertNotIn("-count_packets", calls.call_args.args[0])

    def test_external_corrupt_packet_file_keeps_legacy_scan(self):
        from tachie_motion.render.prores import encode_prores
        from tachie_motion.timeline import media
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            mov = root / "good.mov"
            encode_prores(_states(root), mov, fps=30, frames_per_state=1)
            external = root / "corrupted.mov"
            shutil.copyfile(mov, external)
            cmd = [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_packets", "-show_entries", "packet=pos,size,flags",
                "-of", "json", str(external)
            ]
            packet_before = json.loads(
                subprocess.run(cmd, capture_output=True, check=True).stdout
            )["packets"]
            raw = bytearray(external.read_bytes())
            pos = int(packet_before[0]["pos"])
            limit = pos + min(64, int(packet_before[0]["size"]))
            at = raw.find(b"icpf", pos, limit)
            self.assertGreaterEqual(at, pos)
            raw[at:at+4] = b"xxxx"
            external.write_bytes(raw)
            packet_after = json.loads(
                subprocess.run(cmd, capture_output=True, check=True).stdout
            )["packets"]
            self.assertEqual(packet_before, packet_after)
            original_run = subprocess.run
            with patch.object(media.subprocess, "run", wraps=original_run) as calls:
                try:
                    probe_movie(external)
                except (RuntimeError, ValueError):
                    pass
            self.assertEqual(calls.call_count, 1)
            self.assertIn("-count_frames", calls.call_args.args[0])
            self.assertNotIn("-count_packets", calls.call_args.args[0])


class VerifiedExportContractTests(unittest.TestCase):
    def test_duration_mismatch_prevents_encoding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wav = root / "test.wav"
            make_test_tone(wav, duration=Fraction(1, 1))
            from tachie_motion.timeline import verified_export as export
            with patch.object(export, "encode_prores") as encode:
                with self.assertRaisesRegex(ValueError, "Duration mismatch"):
                    export_verified_utterance(
                        [root / "x.png", root / "y.png"],
                        mov=root / "new.mov", wav=wav,
                        otio=root / "new.otio",
                        fps=30, frames_per_state=1
                    )
            encode.assert_not_called()

    def test_unsupported_rate_or_occupied_output_rejected_before_encoding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wav = root / "test.wav"
            make_test_tone(wav, duration=Fraction(1, 1))
            from tachie_motion.timeline import verified_export as export
            dest = root / "new.mov"
            with patch.object(export, "encode_prores") as encode:
                with self.assertRaisesRegex(ValueError, "fps must be"):
                    export_verified_utterance(
                        [root / "x.png", root / "y.png"],
                        mov=dest, wav=wav, otio=root / "new.otio",
                        fps=25
                    )
                dest.write_bytes(b"existing user file")
                with self.assertRaises(FileExistsError):
                    export_verified_utterance(
                        [root / "x.png", root / "y.png"],
                        mov=dest, wav=wav, otio=root / "new.otio"
                    )
            self.assertEqual(dest.read_bytes(), b"existing user file")
            encode.assert_not_called()

    def test_no_external_mov_or_legacy_skip_parameter(self):
        import inspect
        signature = inspect.signature(export_verified_utterance)
        self.assertNotIn("verified", signature.parameters)
        self.assertNotIn("skip_validation", signature.parameters)
        self.assertNotIn("existing_mov", signature.parameters)
        self.assertIn("pngs", signature.parameters)


if __name__ == "__main__":
    unittest.main()
