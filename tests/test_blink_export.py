"""Synthetic end-to-end backend blink MOV checks; never use private PSD/WAV."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from PIL import Image
from psd_tools import PSDImage

from tachie_motion.web.service import (
    describe_psd, describe_wav, describe_wav_lab,
)
from test_web_api import fixture

try:
    from fastapi.testclient import TestClient
    import httpx2  # noqa: F401; required by existing TestClient suite
except (ImportError, RuntimeError):
    TestClient = None


@unittest.skipUnless(TestClient is not None, "httpx test extra required")
class BlinkExportApiTests(unittest.TestCase):
    def setUp(self):
        from tachie_motion.web.app import app
        self.client = TestClient(app, base_url="http://127.0.0.1:8765")
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.source, self.wav, mouth_close, mouth_open = fixture(self.root)
        psd = PSDImage.open(self.source)
        eye_group = psd.create_group(name="blink eyes")
        eye_group.create_pixel_layer(
            Image.new("RGBA", (14, 7), (220, 100, 50, 255)),
            name="open eye", left=3, top=35,
        )
        shut = eye_group.create_pixel_layer(
            Image.new("RGBA", (14, 7), (30, 70, 210, 255)),
            name="closed eye", left=3, top=35,
        )
        shut.visible = False
        psd.save(self.source)

        info = describe_psd(str(self.source))
        mouth_layers = [layer for layer in info["layers"]
                        if layer["name"] == "mouth" and "/" in layer["path"]]
        mouth_close = next(layer["path"] for layer in mouth_layers if layer["visible"])
        mouth_open = next(layer["path"] for layer in mouth_layers if not layer["visible"])
        paths = {entry["name"]: entry["path"] for entry in info["layers"]}
        self.eye_group = paths["blink eyes"]
        self.eye_open = paths["open eye"]
        self.eye_close = paths["closed eye"]
        self.mouth_group = mouth_close.rsplit("/", 1)[0]
        self.mouth_close = mouth_close
        self.mouth_open = mouth_open
        self.mouth = {
            "closed": [
                {"path": mouth_close, "visible": True},
                {"path": mouth_open, "visible": False},
            ],
            "opened": [
                {"path": mouth_close, "visible": False},
                {"path": mouth_open, "visible": True},
            ],
        }
        self.body = {
            "psd": str(self.source),
            "wav": str(self.wav),
            "source_identity": describe_wav(str(self.wav))["source_identity"],
            "fingerprint": info["fingerprint"],
            "layers": [{"path": x["path"], "visible": x["visible"]}
                       for x in info["layers"]],
            "mouth": None,
            "mouth_groups": [self.mouth_group],
            "mode": "none",
            "blink_enabled": True,
            "eyes": {"opened": [], "closed": [
                {"path": self.eye_open, "visible": False},
                {"path": self.eye_close, "visible": True},
            ]},
            "eye_groups": [self.eye_group],
            "blink_timing": {
                "interval_frames": 2, "closed_frames": 1,
                "jitter_frames": 0, "phase_frames": 1, "seed": 23,
            },
            "output_dir": str(self.root),
            "basename": "blink",
            "fps": 30,
        }
        self.original = (self.source.read_bytes(), self.wav.read_bytes())

    def post(self, **changes):
        return self.client.post(
            "/api/preset-utterance-export", json={**self.body, **changes},
        )

    @staticmethod
    def decoded_video(path):
        size = subprocess.run([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path),
        ], check=True, capture_output=True, text=True).stdout.strip()
        width, height = (int(x) for x in size.split(","))
        raw = subprocess.run([
            "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0",
            "-pix_fmt", "rgba", "-f", "rawvideo", "-",
        ], check=True, capture_output=True).stdout
        step = width * height * 4
        assert len(raw) % step == 0
        return [raw[i:i + step] for i in range(0, len(raw), step)]

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_none_mode_blinks_without_altering_pcm_and_otio(self):
        result = self.post()
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["frames"], 4)
        mov = self.root / "blink.mov"
        frames = self.decoded_video(mov)
        self.assertEqual(len(frames), 4)
        self.assertEqual(frames[0], frames[2])
        self.assertEqual(frames[1], frames[3])
        self.assertNotEqual(frames[0], frames[1])
        doc = json.loads((self.root / "blink.otio").read_text("utf-8"))
        self.assertEqual(
            doc["tracks"]["children"][1]["children"][0][
                "media_references"]["DEFAULT_MEDIA"]["target_url"],
            str(mov.resolve()),
        )
        self.assertEqual(
            subprocess.run([
                "ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(mov),
            ], check=True, capture_output=True, text=True).stdout.strip(),
            "pcm_s16le",
        )
        self.assertEqual((self.source.read_bytes(), self.wav.read_bytes()),
                         self.original)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_open_and_aiueo_can_render_with_blink(self):
        open_result = self.post(
            mode="open", mouth=self.mouth, basename="blink_open",
        )
        self.assertEqual(open_result.status_code, 200, open_result.text)
        self.assertEqual(len(self.decoded_video(
            self.root / "blink_open.mov")), 4)

        lab = self.wav.with_suffix(".lab")
        lab.write_text(
            "0 400000 a\n400000 1010000 i\n", encoding="utf-8",
        )
        lab_status = describe_wav_lab(
            str(self.wav), self.body["source_identity"],
        )
        self.assertEqual(lab_status["status"], "valid")
        aiueo = {
            key: [{"path": self.mouth_open if key in ("a", "i")
                   else self.mouth_close, "visible": True}]
            for key in ("a", "i", "u", "e", "o", "n")
        }
        result = self.post(
            mode="aiueo", aiueo_mouth=aiueo,
            lab_source_identity=lab_status["source_identity"],
            basename="blink_aiueo",
        )
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(self.decoded_video(
            self.root / "blink_aiueo.mov")), 4)
        self.assertEqual((self.source.read_bytes(), self.wav.read_bytes()),
                         self.original)

    def test_blink_errors_leave_output_unpublished(self):
        invalid = (
            {"blink_timing": None},
            {"blink_timing": {**self.body["blink_timing"],
                              "interval_frames": 0}},
            {"eye_groups": []},
            {"eye_groups": [self.mouth_group]},
            {"eyes": {"opened": [], "closed": []}},
            {"eyes": {"opened": [], "closed": [
                {"path": self.eye_close, "visible": True},
                {"path": self.eye_close, "visible": True},
            ]}},
        )
        for changes in invalid:
            with self.subTest(changes=changes):
                response = self.post(**changes)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertFalse((self.root / "blink.mov").exists())
                self.assertFalse((self.root / "blink.otio").exists())
        self.assertEqual((self.source.read_bytes(), self.wav.read_bytes()),
                         self.original)


if __name__ == "__main__":
    unittest.main()
