"""Real synthetic PSD+WAV integration for staged whole-generation batch export."""
import json
import subprocess
import tempfile
from pathlib import Path
import unittest

from PIL import Image
from psd_tools import PSDImage

try:
    from fastapi.testclient import TestClient
except ImportError:
    TestClient = None

from test_web_api import fixture
from tachie_motion.psd.tree import walk_layers
from tachie_motion.web.service import describe_psd, describe_wav, describe_wav_lab


@unittest.skipUnless(TestClient is not None, "FastAPI test extra required")
class BatchGenerationApiTests(unittest.TestCase):
    def setUp(self):
        from tachie_motion.web.app import app
        self.app = app
        self.client = TestClient(app, base_url="http://127.0.0.1:8765")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.psd, self.wav, self.closed, self.opened = fixture(self.root)
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
                "lab_source_identity": self.base.get("lab_source_identity"),
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
        self.assertEqual(Path(a["mov"]).resolve(), public.resolve())
        self.assertEqual(Path(a["mov"]).name, public.name)
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
                public = self.root / (self.names[i] + ".mov")
                self.assertEqual(Path(uri).resolve(), public.resolve())
                self.assertEqual(Path(uri).name, public.name)
                self.assertFalse(uri.startswith("file://"))
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
        stages = sorted(self.root.glob(".tachie-batch-stage-*"))
        self.assertGreaterEqual(len(stages), 2, "successful and partial stages remain")
        self.cancel()
        self.assertEqual(sorted(self.root.glob(".tachie-batch-stage-*")), stages,
                         "cancel releases the lease without deleting staged data")
        self.assertTrue(any((stage / (self.names[0] + ".mov")).exists()
                            for stage in stages))

    def test_same_name_batch_overwrite_is_supported_with_existing_timeline(self):
        policy = self.start(overwrite=False)
        self.finish(policy, [self.mov(i, policy) for i in range(2)])
        policy = self.start(overwrite=True)
        self.finish(policy, [self.mov(i, policy) for i in range(2)])
        self.assertEqual(len(list(self.root.glob("*.otio"))), 1)
        self.assertFalse(any(p.name.startswith(".tachie-batch-recovery-")
                             for p in self.root.iterdir()))


    def test_foreign_otio_preflight_matches_start_guard_without_changes(self):
        # Stage nothing if a second timeline may reference overwritten MOVs.
        original = b"existing media; keep unchanged"
        for name in self.names:
            (self.root / (name + ".mov")).write_bytes(original)
        (self.root / (self.timeline + ".otio")).write_bytes(original)
        other = self.root / "別の編集.OTIO"
        other.write_bytes(original)

        status = self.send("preset-combined-otio-destination", {
            "output_dir": str(self.root), "basename": self.timeline,
        })
        self.assertTrue(status["other_otio_present"])
        self.assertEqual(status["state"], "complete")
        response = self.client.post("/api/preset-batch-start", json={
            "output_dir": str(self.root), "timeline_basename": self.timeline,
            "timeline_policy": "overwrite", "entries": [{
                "basename": name, "wav": str(self.wav),
                "source_identity": self.base["source_identity"],
                "fps": 30, "samples": self.samples,
                "sample_rate": self.sample_rate, "conflict_policy": "overwrite",
            } for name in self.names],
        })
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("Another OTIO", response.text)
        for name in self.names:
            self.assertEqual((self.root / (name + ".mov")).read_bytes(), original)
        self.assertEqual(other.read_bytes(), original)
        self.assertFalse(list(self.root.glob(".tachie-batch-stage-*")))

        # Preview is not permission: if a foreign timeline arrives after the
        # user last checked, the start gate still refuses it.
        other.unlink()
        status = self.send("preset-combined-otio-destination", {
            "output_dir": str(self.root), "basename": self.timeline,
        })
        self.assertFalse(status["other_otio_present"])
        other.write_bytes(original)
        response = self.client.post("/api/preset-batch-start", json={
            "output_dir": str(self.root), "timeline_basename": self.timeline,
            "timeline_policy": "overwrite", "entries": [{
                "basename": name, "wav": str(self.wav),
                "source_identity": self.base["source_identity"],
                "fps": 30, "samples": self.samples,
                "sample_rate": self.sample_rate, "conflict_policy": "overwrite",
            } for name in self.names],
        })
        self.assertEqual(response.status_code, 400, response.text)

    def test_foreign_otio_does_not_block_fresh_movie_names(self):
        (self.root / "別の編集.otio").write_text("existing user timeline", encoding="utf-8")
        status = self.send("preset-combined-otio-destination", {
            "output_dir": str(self.root), "basename": self.timeline,
        })
        self.assertTrue(status["other_otio_present"])
        self.start(overwrite=False)
        self.cancel()

    def test_aiueo_batch_generates_all_movs_and_one_otio(self):
        # Give rest n its own yellow leaf, distinct from both the fixed red
        # mouth and the blue vowel a, without changing the shared fixture.
        psd = PSDImage.open(self.psd)
        face = next(layer for layer in psd if layer.name == "face")
        rest = face.create_pixel_layer(
            Image.new("RGBA", (14, 8), (250, 200, 20, 255)),
            name="rest", left=28, top=14,
        )
        rest.visible = False
        psd.save(self.psd)
        meta = describe_psd(str(self.psd))
        self.base["fingerprint"] = meta["fingerprint"]
        self.base["layers"] = [{"path": layer["path"], "visible": layer["visible"]}
                               for layer in meta["layers"]]
        rest_path = next("/".join(map(str, layer.index_path))
                         for layer in walk_layers(PSDImage.open(self.psd))
                         if layer.name == "rest")
        lab = self.wav.with_suffix(".lab")
        # 30-fps frame centers: rest n, vowel a, then vowel i twice.
        lab.write_text("0 300000 sil\n300000 700000 a\n700000 1010000 i\n",
                       encoding="utf-8")
        shapes = {key: [
            {"path": self.closed, "visible": key in ("i", "e")},
            {"path": self.opened, "visible": key in ("a", "u", "o")},
            {"path": rest_path, "visible": key == "n"},
        ] for key in ("a", "i", "u", "e", "o", "n")}
        self.base.update({
            "mode": "aiueo", "aiueo_mouth": shapes,
            "mouth_groups": [self.closed.rsplit("/", 1)[0]],
            "lab_source_identity": describe_wav_lab(
                str(self.wav), self.base["source_identity"])["source_identity"],
        })
        original_psd, original_wav, original_lab = (
            self.psd.read_bytes(), self.wav.read_bytes(), lab.read_bytes())
        policy = self.start(overwrite=False)
        outputs = [self.mov(i, policy) for i in range(len(self.names))]
        self.assertTrue(all(output["frames"] == 4 for output in outputs))
        done = self.finish(policy, outputs)
        self.assertEqual(done["entries"], len(self.names))
        for name in self.names:
            mov = self.root / (name + ".mov")
            self.assertTrue(mov.is_file())
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height", "-of", "csv=p=0", str(mov),
            ], check=True, stdout=subprocess.PIPE, text=True)
            width, height = (int(n) for n in probe.stdout.strip().split(","))
            decoded = subprocess.run([
                "ffmpeg", "-v", "error", "-i", str(mov), "-map", "0:v:0",
                "-pix_fmt", "rgba", "-f", "rawvideo", "-",
            ], check=True, stdout=subprocess.PIPE).stdout
            stride = width * height * 4
            self.assertEqual(len(decoded), stride * 4)
            rgba = [decoded[i * stride:(i + 1) * stride] for i in range(4)]
            self.assertNotEqual(rgba[0], rgba[1], "rest n must not alias vowel a")
            self.assertNotEqual(rgba[0], rgba[2], "rest n must not silently inherit the closed base")
            self.assertNotEqual(rgba[1], rgba[2], "a and i must render different poses")
            self.assertEqual(rgba[2], rgba[3], "later vowel holds its own pose")
            # A color oracle independent of the mouth scheduler proves that
            # n selected the synthetic yellow rest leaf, not just a third pose.
            def has_rest_color(frame):
                return any(frame[i] > 200 and frame[i + 1] > 150 and
                           frame[i + 2] < 70 and frame[i + 3] > 200
                           for i in range(0, len(frame), 4))

            self.assertTrue(has_rest_color(rgba[0]), "n must show the yellow rest leaf")
            self.assertFalse(has_rest_color(rgba[1]), "a must hide the rest leaf")
            self.assertFalse(has_rest_color(rgba[2]), "i must hide the rest leaf")
        combined = self.root / (self.timeline + ".otio")
        self.assertTrue(combined.is_file())
        document = json.loads(combined.read_text("utf-8"))
        self.assertEqual(len(document["tracks"]["children"][1]["children"]),
                         len(self.names))
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes(),
                          lab.read_bytes()), (original_psd, original_wav, original_lab))

    def test_aiueo_batch_rejects_unselected_rest_without_publication(self):
        lab = self.wav.with_suffix(".lab")
        lab.write_text("0 500000 sil\n500000 1010000 a\n", encoding="utf-8")
        shapes = {key: [{"path": self.opened, "visible": True}]
                  for key in ("a", "i", "u", "e", "o", "n")}
        shapes["n"] = []  # No implicit fixed-layer inheritance.
        self.base.update({
            "mode": "aiueo", "aiueo_mouth": shapes,
            "mouth_groups": [self.closed.rsplit("/", 1)[0]],
            "lab_source_identity": describe_wav_lab(
                str(self.wav), self.base["source_identity"])["source_identity"],
        })
        original = (self.psd.read_bytes(), self.wav.read_bytes(), lab.read_bytes())
        policy = self.start(overwrite=False)
        response = self.client.post("/api/preset-batch-mov-export", json={
            **self.base, "basename": self.names[0],
            "conflict_policy": policy, "batch_id": self.token,
            "batch_index": 0,
        })
        self.assertEqual(response.status_code, 400, response.text)
        self.assertFalse(any(self.root.glob("*.mov")))
        self.assertFalse(any(self.root.glob("*.otio")))
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes(),
                          lab.read_bytes()), original)

    def test_lab_changed_after_aiueo_staging_blocks_combined_publication(self):
        from unittest.mock import patch
        from tachie_motion.web.combined_otio import create_combined_otio

        self.names = self.names[:1]
        lab = self.wav.with_suffix(".lab")
        lab.write_text("0 200000 k\n200000 500000 a\n500000 1010000 i\n",
                       encoding="utf-8")
        shapes = {key: [
            {"path": self.closed, "visible": key not in ("a", "u", "o")},
            {"path": self.opened, "visible": key in ("a", "u", "o")},
        ] for key in ("a", "i", "u", "e", "o", "n")}
        self.base.update({
            "mode": "aiueo", "aiueo_mouth": shapes,
            "mouth_groups": [self.closed.rsplit("/", 1)[0]],
            "lab_source_identity": describe_wav_lab(
                str(self.wav), self.base["source_identity"])["source_identity"],
        })
        policy = self.start(overwrite=False)
        output = self.mov(0, policy)
        self.assertFalse((self.root / (self.names[0] + ".mov")).exists())

        def edit_after_timeline(*args, **kwargs):
            result = create_combined_otio(*args, **kwargs)
            lab.write_text("0 1010000 u\n", encoding="utf-8")
            return result

        with patch("tachie_motion.web.app.create_combined_otio",
                   side_effect=edit_after_timeline):
            response = self.client.post("/api/preset-combined-otio", json={
                "output_dir": str(self.root), "basename": self.timeline,
                "conflict_policy": policy, "batch_id": self.token,
                "entries": [{
                    "basename": self.names[0], "frames": output["frames"], "fps": 30,
                    "samples": output["sample_count"],
                    "sample_rate": output["sample_rate"],
                }],
            })
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("LAB changed", response.text)
        self.assertFalse((self.root / (self.names[0] + ".mov")).exists())
        self.assertFalse((self.root / (self.timeline + ".otio")).exists())

    def test_wav_changed_after_staging_rejects_timeline_publication(self):
        policy = self.start(overwrite=False)
        staged = [self.mov(i, policy) for i in range(2)]
        payload = bytearray(self.wav.read_bytes())
        payload[-1] ^= 1
        self.wav.write_bytes(payload)
        denied = self.client.post("/api/preset-combined-otio", json={
            "output_dir": str(self.root), "basename": self.timeline,
            "conflict_policy": policy, "batch_id": self.token,
            "entries": [{
                "basename": name, "frames": output["frames"], "fps": 30,
                "samples": output["sample_count"],
                "sample_rate": output["sample_rate"],
            } for name, output in zip(self.names, staged)],
        })
        self.assertEqual(denied.status_code, 400, denied.text)
        self.assertIn("WAV changed since registration", denied.text)
        self.assertFalse((self.root / (self.timeline + ".otio")).exists())
        for name in self.names:
            self.assertFalse((self.root / (name + ".mov")).exists())


if __name__ == "__main__":
    unittest.main()
