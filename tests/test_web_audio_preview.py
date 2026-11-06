"""Browser WAV audition uses bounded, same-origin local reads only."""

import tempfile
from pathlib import Path
import wave
import unittest

from fastapi.testclient import TestClient
import httpx2  # noqa: F401

from tachie_motion.web.app import app


class WavPlaybackApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="http://127.0.0.1:8765")
        self.headers = {"Origin": "http://127.0.0.1:8765"}

    def test_valid_wav_is_read_only_and_binary_not_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "音声 た\u3099んもん.wav"
            with wave.open(str(source), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(b"\x00\x00" * 160)
            original = source.read_bytes()
            response = self.client.post("/api/wav-playback", json={"path": str(source)},
                headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers["content-type"], "audio/wav")
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual(response.content, original)
            self.assertEqual(source.read_bytes(), original)

    def test_non_wav_remote_origin_and_oversize_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            nonwav = Path(tmp) / "secret.txt"
            nonwav.write_text("not audio")
            fake = Path(tmp) / "invalid.wav"
            fake.write_bytes(b"this is not a WAV")
            big = Path(tmp) / "large.wav"
            with big.open("wb") as output:
                output.truncate(128 * 1024 * 1024 + 1)

            for path in (str(nonwav), str(fake), str(big), "relative.wav"):
                with self.subTest(path=path):
                    self.assertEqual(self.client.post("/api/wav-playback",
                        json={"path": path}, headers=self.headers).status_code, 400)
            self.assertEqual(self.client.post("/api/wav-playback",
                json={"path": str(fake)}, headers={"Origin": "https://evil.example"}).status_code,
                403)
            self.assertEqual(self.client.get("/api/wav-playback").status_code, 405)


if __name__ == "__main__":
    unittest.main()
