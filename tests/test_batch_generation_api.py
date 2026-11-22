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

    def start_selective(self, ids, flags, policy):
        self.assertEqual(len(ids), len(self.names))
        self.assertEqual(len(flags), len(self.names))
        payload = {
            "output_dir": str(self.root), "timeline_basename": self.timeline,
            "timeline_policy": policy,
            "entries": [{
                "item_id": item_id, "reuse": reuse, "basename": name,
                "wav": str(self.wav),
                "source_identity": self.base["source_identity"],
                "fps": 30, "samples": self.samples,
                "sample_rate": self.sample_rate,
                "conflict_policy": policy,
                "lab_source_identity": None,
            } for item_id, reuse, name in zip(ids, flags, self.names)],
        }
        self.token = self.send("preset-batch-start", payload)["batch_id"]
        return policy

    def test_mixed_speech_idle_speech_stages_and_publishes_one_otio(self):
        """No public idle/speech MOV exists before whole-generation commit."""
        from tachie_motion.web.combined_otio import probe_no_embedded_audio
        info = describe_psd(str(self.psd))
        idle_name = "002_無音待機"
        policy = "error"
        entries = []
        for index, name in enumerate((self.names[0], idle_name, self.names[1])):
            if index == 1:
                entries.append({
                    "kind": "idle", "item_id": "stable-idle-1",
                    "basename": name, "psd": str(self.psd),
                    "fingerprint": info["fingerprint"],
                    "source_identity": info["source_identity"],
                    "fps": 30, "frames": 60, "conflict_policy": policy,
                    "layers": self.base["layers"], "blink_enabled": False,
                })
            else:
                entries.append({
                    "item_id": f"stable-speech-{index}",
                    "basename": name, "wav": str(self.wav),
                    "source_identity": self.base["source_identity"],
                    "fps": 30, "samples": self.samples,
                    "sample_rate": self.sample_rate, "conflict_policy": policy,
                })
        original = (self.psd.read_bytes(), self.wav.read_bytes())
        self.token = self.send("preset-batch-start", {
            "output_dir": str(self.root), "timeline_basename": self.timeline,
            "timeline_policy": policy, "entries": entries,
        })["batch_id"]
        first = self.mov(0, policy)
        self.assertFalse((self.root / (self.names[0] + ".mov")).exists())
        idle = self.send("preset-batch-idle-export", {
            "psd": str(self.psd), "fingerprint": info["fingerprint"],
            "source_identity": info["source_identity"],
            "layers": self.base["layers"], "frame_count": 60, "fps": 30,
            "output_dir": str(self.root), "basename": idle_name,
            "conflict_policy": policy, "batch_id": self.token, "batch_index": 1,
        })
        self.assertFalse(idle["audio"])
        self.assertEqual(idle["frames"], 60)
        self.assertFalse((self.root / (idle_name + ".mov")).exists())
        last = self.send("preset-batch-mov-export", {
            **self.base, "basename": self.names[1], "conflict_policy": policy,
            "batch_id": self.token, "batch_index": 2,
        })
        self.assertFalse((self.root / (self.names[1] + ".mov")).exists())
        otio = self.send("preset-combined-otio", {
            "output_dir": str(self.root), "basename": self.timeline,
            "conflict_policy": policy, "batch_id": self.token,
            "entries": [
                {"basename": self.names[0], "frames": first["frames"],
                 "fps": 30, "samples": first["sample_count"],
                 "sample_rate": first["sample_rate"]},
                {"kind": "idle", "basename": idle_name, "frames": 60, "fps": 30},
                {"basename": self.names[1], "frames": last["frames"],
                 "fps": 30, "samples": last["sample_count"],
                 "sample_rate": last["sample_rate"]},
            ],
        })
        self.assertEqual(otio["entries"], 3)
        for name in (self.names[0], idle_name, self.names[1]):
            self.assertTrue((self.root / (name + ".mov")).is_file())
        probe_no_embedded_audio(self.root / (idle_name + ".mov"))
        document = json.loads((self.root / (self.timeline + ".otio")).read_text())
        video, audio = document["tracks"]["children"]
        self.assertEqual(
            [clip["name"] for clip in video["children"]],
            ["Character MOV", "Idle MOV", "Character MOV"])
        self.assertEqual(
            [clip["OTIO_SCHEMA"] for clip in audio["children"]],
            ["Clip.2", "Gap.1", "Clip.2"])
        self.assertEqual(
            video["children"][1]["source_range"]["duration"],
            audio["children"][1]["source_range"]["duration"])
        self.assertNotIn("media_references", audio["children"][1])
        self.assertNotIn("tachie_motion_selective", document["metadata"])
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), original)

    def test_idle_source_digest_failure_releases_session_lease(self):
        from unittest.mock import patch
        from tachie_motion.web.batch_session import BatchCoordinator
        from tachie_motion.web.selective_recipe import digest_regular_file
        from tachie_motion.web.batch_publish import recovery_directories
        info = describe_psd(str(self.psd))
        idle = {
            "kind": "idle", "item_id": "idle-1", "basename": "idle-safe",
            "psd": str(self.psd), "fingerprint": info["fingerprint"],
            "source_identity": info["source_identity"],
            "fps": 30, "frames": 30, "conflict_policy": "error",
            "layers": self.base["layers"], "blink_enabled": False,
        }
        coordinator = BatchCoordinator()
        with patch("tachie_motion.web.batch_session.digest_regular_file",
                   side_effect=OSError("synthetic unreadable PSD")):
            with self.assertRaisesRegex(OSError, "unreadable PSD"):
                coordinator.start(self.root, "test-timeline", "error", [idle])
        self.assertIsNone(coordinator.active)
        coordinator.require_idle()
        self.assertFalse(list(self.root.glob("*.mov")))
        self.assertFalse(list(self.root.glob("*.otio")))
        self.assertFalse(recovery_directories(self.root))

    def test_mixed_batch_reuse_claim_is_rejected_before_stage(self):
        info = describe_psd(str(self.psd))
        response = self.client.post("/api/preset-batch-start", json={
            "output_dir": str(self.root), "timeline_basename": "mix",
            "timeline_policy": "error",
            "entries": [{
                "item_id": "speech", "reuse": True,
                "basename": "speech", "wav": str(self.wav),
                "source_identity": self.base["source_identity"],
                "fps": 30, "samples": self.samples,
                "sample_rate": self.sample_rate, "conflict_policy": "error",
            }, {
                "kind": "idle", "item_id": "idle", "basename": "idle",
                "psd": str(self.psd), "fingerprint": info["fingerprint"],
                "source_identity": info["source_identity"], "fps": 30,
                "frames": 30, "conflict_policy": "error",
                "layers": self.base["layers"], "blink_enabled": False,
            }],
        })
        self.assertEqual(response.status_code, 400, response.text)
        self.assertFalse(list(self.root.glob("*.mov")))
        self.assertFalse(list(self.root.glob("*.otio")))

    def test_selective_reorder_updates_only_otio_and_calls_no_encoder(self):
        """Real synthetic PSD→MOV, followed by full cache reuse and new OTIO."""
        from unittest.mock import patch
        ids = ["stable-one", "stable-two"]
        self.start_selective(ids, [False, False], "error")
        created = [self.mov(i, "error") for i in range(2)]
        self.finish("error", created)
        old = {
            name: ((self.root / (name + ".mov")).stat().st_ino,
                   (self.root / (name + ".mov")).read_bytes())
            for name in self.names
        }
        original_timeline = (self.root / (self.timeline + ".otio")).read_bytes()
        first = json.loads(original_timeline)
        self.assertEqual(len(
            first["metadata"]["tachie_motion_selective"]["entries"]), 2)
        self.names.reverse()
        ids.reverse()
        self.start_selective(ids, [True, True], "overwrite")
        with patch("tachie_motion.web.app.export_preset_utterance",
                   side_effect=RuntimeError("encoder was invoked")) as encoder:
            reused = [self.mov(i, "overwrite") for i in range(2)]
            encoder.assert_not_called()
        self.assertTrue(all(item["reused"] for item in reused))
        self.finish("overwrite", reused)
        self.assertNotEqual(
            (self.root / (self.timeline + ".otio")).read_bytes(),
            original_timeline)
        for name in self.names:
            movie = self.root / (name + ".mov")
            self.assertEqual((movie.stat().st_ino, movie.read_bytes()), old[name])
        updated = json.loads((self.root / (self.timeline + ".otio")).read_text(
            encoding="utf-8"))
        for track in updated["tracks"]["children"]:
            self.assertEqual([
                Path(clip["media_references"]["DEFAULT_MEDIA"]["target_url"]).name
                for clip in track["children"]
            ], [name + ".mov" for name in self.names])

    def test_selective_fps_change_reencodes_only_one_movie(self):
        """Only changed output calls the encoder; untouched MOV remains byte-identical."""
        from unittest.mock import patch
        from tachie_motion.web.preset_utterance import export_preset_utterance
        ids = ["stable-one", "stable-two"]
        self.start_selective(ids, [False, False], "error")
        self.finish("error", [self.mov(i, "error") for i in range(2)])
        stable = self.root / (self.names[0] + ".mov")
        dirty = self.root / (self.names[1] + ".mov")
        stable_before = (stable.stat().st_ino, stable.read_bytes())
        dirty_before = dirty.read_bytes()
        start_request = {
            "output_dir": str(self.root), "timeline_basename": self.timeline,
            "timeline_policy": "overwrite",
            "entries": [{
                "item_id": item_id, "reuse": index == 0,
                "basename": name, "wav": str(self.wav),
                "source_identity": self.base["source_identity"],
                "fps": 30 if index == 0 else 24,
                "samples": self.samples, "sample_rate": self.sample_rate,
                "conflict_policy": "overwrite",
            } for index, (item_id, name) in enumerate(zip(ids, self.names))],
        }
        self.token = self.send("preset-batch-start", start_request)["batch_id"]
        with patch("tachie_motion.web.app.export_preset_utterance",
                   wraps=export_preset_utterance) as encoder:
            reused = self.mov(0, "overwrite")
            changed = self.send("preset-batch-mov-export", {
                **self.base, "basename": self.names[1], "fps": 24,
                "conflict_policy": "overwrite",
                "batch_id": self.token, "batch_index": 1,
            })
            self.assertEqual(encoder.call_count, 1)
        self.assertTrue(reused["reused"])
        self.assertFalse(changed.get("reused", False))
        finished = self.send("preset-combined-otio", {
            "output_dir": str(self.root), "basename": self.timeline,
            "conflict_policy": "overwrite", "batch_id": self.token,
            "entries": [
                {"basename": self.names[0], "frames": reused["frames"],
                 "fps": 30, "samples": self.samples,
                 "sample_rate": self.sample_rate},
                {"basename": self.names[1], "frames": changed["frames"],
                 "fps": 24, "samples": self.samples,
                 "sample_rate": self.sample_rate},
            ],
        })
        self.assertEqual(finished["entries"], 2)
        self.assertEqual((stable.stat().st_ino, stable.read_bytes()), stable_before)
        self.assertNotEqual(dirty.read_bytes(), dirty_before)

    def test_selective_external_mov_edit_invalidates_reuse(self):
        """A swapped public MOV cannot be silently accepted as a cache hit."""
        from unittest.mock import patch
        ids = ["stable-one", "stable-two"]
        self.start_selective(ids, [False, False], "error")
        self.finish("error", [self.mov(i, "error") for i in range(2)])
        hint = {
            "timeline_basename": self.timeline, "item_id": ids[0],
            "suggested_basename": self.names[0],
            "render": {**self.base, "basename": self.names[0],
                       "conflict_policy": "overwrite"},
        }
        verified_hint = self.send("preset-batch-reuse-candidate", hint)
        self.assertTrue(verified_hint["reuse"])
        self.assertIn("検証済み", verified_hint["reason"])
        old_otio = (self.root / (self.timeline + ".otio")).read_bytes()
        changed_movie = self.root / (self.names[0] + ".mov")
        changed_movie.write_bytes(changed_movie.read_bytes() + b"foreign modification")
        failed_hint = self.send("preset-batch-reuse-candidate", hint)
        self.assertFalse(failed_hint["reuse"])
        self.assertIn("再生成", failed_hint["reason"])
        self.start_selective(ids, [True, True], "overwrite")
        with patch("tachie_motion.web.app.export_preset_utterance",
                   side_effect=RuntimeError("encoder was invoked")) as encoder:
            failed = self.client.post("/api/preset-batch-mov-export", json={
                **self.base, "basename": self.names[0], "conflict_policy": "overwrite",
                "batch_id": self.token, "batch_index": 0,
            })
            encoder.assert_not_called()
        self.assertNotEqual(failed.status_code, 200)
        self.assertEqual((self.root / (self.timeline + ".otio")).read_bytes(), old_otio)

    def test_selective_candidate_explains_missing_history(self):
        response = self.send("preset-batch-reuse-candidate", {
            "timeline_basename": self.timeline, "item_id": "first-run",
            "suggested_basename": self.names[0],
            "render": {**self.base, "basename": self.names[0],
                       "conflict_policy": "overwrite"},
        })
        self.assertFalse(response["reuse"])
        self.assertIn("生成履歴", response["reason"])

    def test_selective_staged_render_cannot_publish_after_psd_changes(self):
        """Changing original PSD after render must not publish stale MOVs or OTIO."""
        ids = ["stable-one", "stable-two"]
        self.start_selective(ids, [False, False], "error")
        results = [self.mov(i, "error") for i in range(2)]
        self.psd.write_bytes(self.psd.read_bytes() + b"external PSD edit")
        failed = self.client.post("/api/preset-combined-otio", json={
            "output_dir": str(self.root), "basename": self.timeline,
            "conflict_policy": "error", "batch_id": self.token,
            "entries": [{
                "basename": name, "frames": result["frames"], "fps": 30,
                "samples": result["sample_count"],
                "sample_rate": result["sample_rate"],
            } for name, result in zip(self.names, results)],
        })
        self.assertNotEqual(failed.status_code, 200)
        for name in self.names:
            self.assertFalse((self.root / (name + ".mov")).exists())
        self.assertFalse((self.root / (self.timeline + ".otio")).exists())

    def test_selective_corrupt_history_refuses_reuse_without_encoding(self):
        from unittest.mock import patch
        ids = ["stable-one", "stable-two"]
        self.start_selective(ids, [False, False], "error")
        self.finish("error", [self.mov(i, "error") for i in range(2)])
        timeline = self.root / (self.timeline + ".otio")
        document = json.loads(timeline.read_text(encoding="utf-8"))
        document["metadata"]["tachie_motion_selective"]["format"] = "corrupted"
        timeline.write_text(json.dumps(document), encoding="utf-8")
        self.assertIsNone(self.app.state.batch.active)
        failed = self.client.post("/api/preset-batch-start", json={
            "output_dir": str(self.root), "timeline_basename": self.timeline,
            "timeline_policy": "overwrite",
            "entries": [{
                "item_id": ids[i], "reuse": True, "basename": name,
                "wav": str(self.wav), "source_identity": self.base["source_identity"],
                "fps": 30, "samples": self.samples,
                "sample_rate": self.sample_rate, "conflict_policy": "overwrite",
            } for i, name in enumerate(self.names)],
        })
        self.assertNotEqual(failed.status_code, 200)
        self.assertFalse(any(
            (self.root / name).is_symlink() for name in
            [*(n + ".mov" for n in self.names), self.timeline + ".otio"]))

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


    def test_late_foreign_otio_blocks_dirty_batch(self):
        self.start(overwrite=False)
        self.finish("error", [self.mov(i, "error") for i in range(2)])
        old = {name: (self.root / name).read_bytes() for name in
               [*(n + ".mov" for n in self.names), self.timeline + ".otio"]}
        self.start(overwrite=True)
        updated = [self.mov(i, "overwrite") for i in range(2)]
        other = self.root / "new-external.otio"
        other.write_bytes(b"FOREIGN-OTIO")
        response = self.client.post("/api/preset-combined-otio", json={
            "output_dir": str(self.root), "basename": self.timeline,
            "conflict_policy": "overwrite", "batch_id": self.token,
            "entries": [{"basename": name, "frames": result["frames"], "fps": 30,
                         "samples": result["sample_count"],
                         "sample_rate": result["sample_rate"]}
                        for name, result in zip(self.names, updated)],
        })
        self.assertNotEqual(response.status_code, 200)
        self.assertEqual(other.read_bytes(), b"FOREIGN-OTIO")
        for name, old_bytes in old.items():
            self.assertEqual((self.root / name).read_bytes(), old_bytes)

    def test_reused_mov_changed_at_publisher_entry_is_rejected(self):
        from unittest.mock import patch
        from tachie_motion.web.batch_publish import publish_batch
        ids = ["stable-one", "stable-two"]
        self.start_selective(ids, [False, False], "error")
        self.finish("error", [self.mov(i, "error") for i in range(2)])
        old_dirty = (self.root / (self.names[1] + ".mov")).read_bytes()
        old_timeline = (self.root / (self.timeline + ".otio")).read_bytes()
        self.start_selective(ids, [True, False], "overwrite")
        results = [self.mov(i, "overwrite") for i in range(2)]
        reusable = self.root / (self.names[0] + ".mov")

        def intervene(**kwargs):
            reusable.write_bytes(reusable.read_bytes() + b"EXTERNAL")
            return publish_batch(**kwargs)

        with patch("tachie_motion.web.batch_session.publish_batch",
                   side_effect=intervene):
            response = self.client.post("/api/preset-combined-otio", json={
                "output_dir": str(self.root), "basename": self.timeline,
                "conflict_policy": "overwrite", "batch_id": self.token,
                "entries": [{"basename": name, "frames": result["frames"],
                             "fps": 30, "samples": result["sample_count"],
                             "sample_rate": result["sample_rate"]}
                            for name, result in zip(self.names, results)],
            })
        self.assertNotEqual(response.status_code, 200)
        self.assertEqual((self.root / (self.names[1] + ".mov")).read_bytes(), old_dirty)
        self.assertEqual((self.root / (self.timeline + ".otio")).read_bytes(), old_timeline)
        self.assertTrue(reusable.read_bytes().endswith(b"EXTERNAL"))

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
