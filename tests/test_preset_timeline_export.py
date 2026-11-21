"""Preset change-point MOV integration using synthetic PSD/WAV, never real media."""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from tachie_motion.web.service import describe_psd, describe_wav
from test_web_api import fixture

try:
    from fastapi.testclient import TestClient
    import httpx2  # noqa: F401
except (ImportError, RuntimeError):
    TestClient = None


@unittest.skipUnless(TestClient is not None, "httpx test extra required")
class PresetTimelineExportTests(unittest.TestCase):
    def setUp(self):
        from tachie_motion.web.app import app
        self.client = TestClient(app, base_url="http://127.0.0.1:8765")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.psd, self.wav, self.closed, self.opened = fixture(self.root)
        info = describe_psd(str(self.psd))
        self.base = [{"path": x["path"], "visible": x["visible"]} for x in info["layers"]]
        self.next_base = [dict(row) for row in self.base]
        for row in self.next_base:
            if row["path"] == self.closed:
                row["visible"] = False
            elif row["path"] == self.opened:
                row["visible"] = True
        self.body = {
            "psd": str(self.psd),
            "wav": str(self.wav),
            "source_identity": describe_wav(str(self.wav))["source_identity"],
            "fingerprint": info["fingerprint"],
            "layers": self.base,
            "mode": "none",
            "blink_enabled": False,
            "output_dir": str(self.root),
            "basename": "timeline",
            "fps": 30,
        }
        self.originals = self.psd.read_bytes(), self.wav.read_bytes()

    def change(self, sample=50):
        return {
            "sample": sample, "preset_id": "smile",
            "layers": self.next_base, "mouth": None,
            "aiueo_mouth": None, "mode": "none",
            "blink_enabled": False, "eyes": None, "blink_timing": None,
        }

    def post(self, **args):
        return self.client.post("/api/preset-utterance-export",
                                json={**self.body, **args})

    def frames(self, mov: Path) -> list[bytes]:
        size = subprocess.run([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0", str(mov),
        ], check=True, capture_output=True, text=True).stdout.strip()
        width, height = (int(x) for x in size.split(","))
        raw = subprocess.run([
            "ffmpeg", "-v", "error", "-i", str(mov), "-map", "0:v:0",
            "-pix_fmt", "rgba", "-f", "rawvideo", "-",
        ], check=True, capture_output=True).stdout
        step = width * height * 4
        self.assertEqual(len(raw) % step, 0)
        return [raw[i:i + step] for i in range(0, len(raw), step)]

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_static_preset_changes_frames_and_pcm_is_preserved(self):
        result = self.post(timeline_changes=[self.change()])
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["frames"], 4)
        mov = self.root / "timeline.mov"
        frames = self.frames(mov)
        self.assertEqual(len(frames), 4)
        self.assertNotEqual(frames[0], frames[1])
        self.assertEqual(frames[1], frames[2])
        self.assertEqual(frames[2], frames[3])
        self.assertEqual(
            subprocess.run([
                "ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(mov),
            ], check=True, capture_output=True, text=True).stdout.strip(),
            "pcm_s16le",
        )
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), self.originals)
        self.assertFalse((self.root / "timeline.otio").exists())

    def test_invalid_change_point_never_publishes_a_mov(self):
        for point in (
            self.change(sample=0),
            self.change(sample=101),
            {**self.change(), "preset_id": ""},
            {**self.change(), "layers": [{"path": "no-such-layer", "visible": True}]},
            {**self.change(), "extra": "malformed"},
        ):
            with self.subTest(point=str(point)[:80]):
                result = self.post(timeline_changes=[point])
                self.assertEqual(result.status_code, 400, result.text)
                self.assertFalse((self.root / "timeline.mov").exists())
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), self.originals)


if __name__ == "__main__":
    unittest.main()
