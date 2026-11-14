"""Real synthetic PSD+WAV integration for staged whole-generation batch export."""
import json
import tempfile
from pathlib import Path
import unittest

try:
    from fastapi.testclient import TestClient
except ImportError:
    TestClient = None

from test_web_api import fixture
from tachie_motion.web.service import describe_psd, describe_wav


@unittest.skipUnless(TestClient is not None, "FastAPI test extra required")
class BatchGenerationApiTests(unittest.TestCase):
    def setUp(self):
        from tachie_motion.web.app import app
        self.app = app
        self.client = TestClient(app, base_url="http://127.0.0.1:8765")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.psd, self.wav, _, _ = fixture(self.root)
        meta = describe_psd(str(self.psd))
        wav = describe_wav(str(self.wav))
        self.base = {
            "psd": str(self.psd), "wav": str(self.wav),
            "fingerprint": meta["fingerprint"],
            "layers": [{"path": x["path"], "visible": x["visible"]} for x in meta["layers"]],
            "mode": "none", "blink_enabled": False, "fps": 30,
            "source_identity": wav["source_identity"],
            "output_dir": str(self.root),
        }
        self.samples = wav["samples"]
        self.sample_rate = wav["sample_rate"]
        self.names = ["001_あんこもん", "002_あんこもん"]
        self.timeline = "作品"
        self.token = None
        self.addCleanup(self.cancel)

    def send(self, endpoint, request):
        response = self.client.post("/api/" + endpoint, json=request)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def start(self, overwrite: bool):
        policy = "overwrite" if overwrite else "error"
        session = self.send("preset-batch-start", {
            "output_dir": str(self.root), "timeline_basename": self.timeline,
            "timeline_policy": policy,
            "entries": [{
                "basename": name, "wav": str(self.wav),
                "source_identity": self.base["source_identity"],
                "fps": 30, "samples": self.samples,
                "sample_rate": self.sample_rate, "conflict_policy": policy,
            } for name in self.names],
        })
        self.token = session["batch_id"]
        return policy

    def mov(self, index, policy):
        return self.send("preset-batch-mov-export", {
            **self.base, "basename": self.names[index],
            "conflict_policy": policy,
            "batch_id": self.token, "batch_index": index,
        })

    def finish(self, policy, outputs):
        return self.send("preset-combined-otio", {
            "output_dir": str(self.root), "basename": self.timeline,
            "conflict_policy": policy, "batch_id": self.token,
            "entries": [{
                "basename": name, "frames": output["frames"], "fps": 30,
                "samples": output["sample_count"],
                "sample_rate": output["sample_rate"],
            } for name, output in zip(self.names, outputs)],
        })

    def cancel(self):
        if self.token:
            self.client.post("/api/preset-batch-cancel",
                             json={"batch_id": self.token})
            self.token = None

    def test_synthetic_batch_is_private_until_all_movie_and_otio_success(self):
        policy = self.start(overwrite=False)
        a = self.mov(0, policy)
        public = self.root / (self.names[0] + ".mov")
        self.assertTrue(a["staged"])
        self.assertEqual(a["mov"], str(public))
        self.assertFalse(public.exists())
        self.assertFalse((self.root / (self.timeline + ".otio")).exists())
        b = self.mov(1, policy)
        self.assertFalse(public.exists())
        result = self.finish(policy, [a, b])
        self.assertEqual(result["entries"], 2)
        self.assertTrue(public.is_file())
        self.assertTrue((self.root / (self.names[1] + ".mov")).is_file())
        otio = self.root / (self.timeline + ".otio")
        self.assertTrue(otio.is_file())
        doc = json.loads(otio.read_text(encoding="utf-8"))
        self.assertEqual(len(doc["tracks"]["children"][0]["children"]), 2)
        self.assertEqual(len(doc["tracks"]["children"][1]["children"]), 2)
        for track in doc["tracks"]["children"]:
            for i, clip in enumerate(track["children"]):
                uri = clip["media_references"]["DEFAULT_MEDIA"]["target_url"]
                self.assertIn(self.names[i] + ".mov", uri)
                self.assertNotIn(".tachie-batch-stage", uri)
                self.assertNotIn(str(self.wav), uri)
        self.assertEqual(len(list(self.root.glob("*.otio"))), 1)

    def test_partial_staged_render_error_leaves_all_old_files_unchanged(self):
        policy = self.start(overwrite=False)
        fresh = [self.mov(i, policy) for i in range(2)]
        self.finish(policy, fresh)
        originals = {name: (self.root / name).read_bytes()
                     for name in [*(n + ".mov" for n in self.names),
                                  self.timeline + ".otio"]}
        policy = self.start(overwrite=True)
        self.mov(0, policy)
        # Next MOV render has invalid layer paths -> must not publish anything.
        broken = {**self.base, "basename": self.names[1],
                  "conflict_policy": policy,
                  "batch_id": self.token, "batch_index": 1, "layers": []}
        failed = self.client.post("/api/preset-batch-mov-export", json=broken)
        self.assertNotEqual(failed.status_code, 200)
        for name, content in originals.items():
            self.assertEqual((self.root / name).read_bytes(), content)
        self.cancel()
        self.assertFalse(any(p.name.startswith(".tachie-batch-stage-")
                             for p in self.root.iterdir()))

    def test_same_name_batch_overwrite_is_supported_with_existing_timeline(self):
        policy = self.start(overwrite=False)
        self.finish(policy, [self.mov(i, policy) for i in range(2)])
        policy = self.start(overwrite=True)
        self.finish(policy, [self.mov(i, policy) for i in range(2)])
        self.assertEqual(len(list(self.root.glob("*.otio"))), 1)
        self.assertFalse(any(p.name.startswith(".tachie-batch-recovery-")
                             for p in self.root.iterdir()))


if __name__ == "__main__":
    unittest.main()
