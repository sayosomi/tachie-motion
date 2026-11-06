"""Issue #4: avoid redundant frame-count scan without accepting corrupt MOVs."""

import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

from tachie_motion.render import probe
from tachie_motion.render.prores import encode_prores


class ProresMetadataTests(unittest.TestCase):
    @staticmethod
    def metadata(nb_frames="4"):
        stream = {
            "codec_name": "prores",
            "profile": "4444",
            "width": 32,
            "height": 32,
            "pix_fmt": "yuva444p12le",
            "r_frame_rate": "30/1",
        }
        if nb_frames is not None:
            stream["nb_frames"] = nb_frames
        return json.dumps({"streams": [stream]}).encode()

    @staticmethod
    def counted(nb_read_frames="4"):
        return json.dumps({
            "streams": [{"nb_read_frames": nb_read_frames}]
        }).encode()

    @staticmethod
    def verified(count=4):
        return (count, 0, 255, 0.0, 0.0, 0, 0.0, 0.0, 0, 0)

    def inspect(self):
        return probe.inspect_prores(
            Path("synthetic.mov"),
            expected_size=(32, 32),
            expected_frames=4,
            expected_fps=30,
        )

    def test_matching_metadata_skips_expensive_count_and_keeps_decode(self):
        with patch.object(probe, "_capture", return_value=self.metadata()) as cap, \
             patch.object(probe, "verify_decoded_frames",
                          return_value=self.verified()) as verify:
            result = self.inspect()
        self.assertEqual(result.frames, 4)
        self.assertEqual(result.decoded_frames, 4)
        self.assertEqual(cap.call_count, 1)
        self.assertNotIn("-count_frames", cap.call_args.args[0])
        self.assertIn("nb_frames", cap.call_args.args[0][
            cap.call_args.args[0].index("-show_entries") + 1
        ])
        verify.assert_called_once()

    def test_missing_invalid_or_mismatched_metadata_uses_real_count(self):
        for metadata_count in (None, "N/A", "bad", "0", "-4", "3", "5"):
            with self.subTest(nb_frames=metadata_count):
                with patch.object(
                    probe, "_capture",
                    side_effect=[
                        self.metadata(metadata_count),
                        self.counted(),
                    ],
                ) as cap, patch.object(
                    probe, "verify_decoded_frames",
                    return_value=self.verified(),
                ) as verify:
                    result = self.inspect()
                self.assertEqual(result.frames, 4)
                self.assertEqual(cap.call_count, 2)
                self.assertNotIn("-count_frames", cap.call_args_list[0].args[0])
                self.assertIn("-count_frames", cap.call_args_list[1].args[0])
                verify.assert_called_once()

    def test_fallback_rejects_actual_count_mismatch(self):
        with patch.object(
            probe, "_capture",
            side_effect=[self.metadata("3"), self.counted("3")],
        ), patch.object(probe, "verify_decoded_frames") as verify:
            with self.assertRaisesRegex(RuntimeError, "Frame count changed"):
                self.inspect()
            verify.assert_not_called()

    def test_fallback_rejects_unreadable_frame_count(self):
        with patch.object(
            probe, "_capture",
            side_effect=[self.metadata(None), self.counted("N/A")],
        ), patch.object(probe, "verify_decoded_frames") as verify:
            with self.assertRaisesRegex(
                RuntimeError, "Incomplete counted-frame ffprobe report"
            ):
                self.inspect()
            verify.assert_not_called()

    def test_wrong_codec_is_rejected_despite_valid_metadata(self):
        data = json.loads(self.metadata())
        data["streams"][0]["codec_name"] = "h264"
        with patch.object(probe, "_capture", return_value=json.dumps(data).encode()), \
             patch.object(probe, "verify_decoded_frames") as verify:
            with self.assertRaisesRegex(RuntimeError, "Expected ProRes 4444"):
                self.inspect()
            verify.assert_not_called()


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "Real FFmpeg and ffprobe required",
)
class RealMovMetadataIntegrityTests(unittest.TestCase):
    def test_stale_metadata_cannot_hide_short_or_excess_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            paths = [folder / "a.png", folder / "b.png"]
            for p, color in zip(paths, ((255, 20, 30, 255), (30, 20, 255, 255))):
                image = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
                ImageDraw.Draw(image).rectangle((4, 4, 27, 27), fill=color)
                image.save(p)
            mov = folder / "two.mov"
            report = encode_prores(paths, mov, frames_per_state=1)
            self.assertEqual(report.decoded_frames, 2)

            # Force an apparently valid but false MOV metadata count. The
            # decoder must still reject underflow and overflow independently.
            fake_three = ProresMetadataTests.metadata("3")
            with patch.object(probe, "_capture", return_value=fake_three):
                with self.assertRaisesRegex(RuntimeError, "stopped early"):
                    probe.inspect_prores(
                        mov, expected_size=(32, 32),
                        expected_frames=3, expected_fps=30,
                    )
            fake_one = ProresMetadataTests.metadata("1")
            with patch.object(probe, "_capture", return_value=fake_one):
                with self.assertRaisesRegex(RuntimeError, "more frames"):
                    probe.inspect_prores(
                        mov, expected_size=(32, 32),
                        expected_frames=1, expected_fps=30,
                    )


if __name__ == "__main__":
    unittest.main()
