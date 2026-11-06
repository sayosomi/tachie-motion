"""Preset-backed one-WAV export: real synthetic PSD/WAV, no user media."""

import json
from pathlib import Path
from PIL import Image
import shutil
import tempfile
import unittest

from tachie_motion.web.preset_utterance import (
    validated_snapshot, validate_open_mouth,
)
from tachie_motion.web.service import describe_psd
from tachie_motion.render.prores import read_rgba_states
from test_web_api import fixture

try:
    from fastapi.testclient import TestClient
    import httpx2  # noqa: F401
except (ImportError, RuntimeError):
    TestClient = None


class PresetSnapshotTests(unittest.TestCase):
    def test_static_single_png_only_opted_in_for_frame_sequence(self):
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / "one.png"
            Image.new("RGBA", (4, 4), (25, 110, 140, 128)).save(image)
            with self.assertRaisesRegex(ValueError, "at least two"):
                read_rgba_states([image])
            dims, states = read_rgba_states([image], allow_single=True)
            self.assertEqual(dims, (4, 4))
            self.assertEqual(len(states), 1)
            self.assertEqual(len(states[0]), 4 * 4 * 4)
            with self.assertRaises(ValueError):
                read_rgba_states([], allow_single=True)

    def test_mouth_rejects_missing_state_hidden_parent_and_unknown_target(self):
        with tempfile.TemporaryDirectory() as temp:
            psd, wav, closed, opened = fixture(Path(temp))
            meta = describe_psd(str(psd))
            base = [{"path": entry["path"], "visible": entry["visible"]}
                    for entry in meta["layers"]]
            image, visibility = validated_snapshot(psd, meta["fingerprint"], base)
            # The base must actually be applied: changing a non-mouth layer
            # to OFF removes its pixels while the original PSD stays unchanged.
            original = psd.read_bytes()
            muted = [dict(item) for item in base]
            for item in muted:
                if item["path"] not in (closed, opened) and item["path"].count("/") == 0:
                    if item["path"] != closed.split("/")[0]:
                        item["visible"] = False
            masked_image, _ = validated_snapshot(psd, meta["fingerprint"], muted)
            from tachie_motion.psd.raster import composite_rgba
            self.assertEqual(composite_rgba(masked_image).getpixel((36, 36))[3], 0)
            self.assertEqual(psd.read_bytes(), original)

            with self.assertRaisesRegex(ValueError, "complete"):
                validate_open_mouth(image, visibility, None)
            with self.assertRaisesRegex(ValueError, "identical"):
                validate_open_mouth(image, visibility, {
                    "closed": [{"path": closed, "visible": True}],
                    "opened": [{"path": closed, "visible": True}],
                })
            with self.assertRaisesRegex(ValueError, "same layers"):
                validate_open_mouth(image, visibility, {
                    "closed": [{"path": closed, "visible": True}],
                    "opened": [{"path": opened, "visible": True}],
                })
            with self.assertRaisesRegex(ValueError, "Duplicate or unknown"):
                validate_open_mouth(image, visibility, {
                    "closed": [{"path": "999", "visible": True}],
                    "opened": [{"path": "999", "visible": False}],
                })
            for entry in base:
                if entry["path"] == closed.split("/")[0]:
                    entry["visible"] = False
            image, visibility = validated_snapshot(psd, meta["fingerprint"], base)
            with self.assertRaisesRegex(ValueError, "hidden parent"):
                validate_open_mouth(image, visibility, {
                    "closed": [{"path": closed, "visible": True}],
                    "opened": [{"path": closed, "visible": False}],
                })


@unittest.skipUnless(TestClient is not None, "httpx test extra required")
class PresetExportApiTests(unittest.TestCase):
    def setUp(self):
        from tachie_motion.web.app import app
        self.client = TestClient(app, base_url="http://127.0.0.1:8765")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.psd, self.wav, self.closed, self.opened = fixture(self.root)
        meta = describe_psd(str(self.psd))
        base = [{"path": x["path"], "visible": x["visible"]} for x in meta["layers"]]
        self.body = {
            "psd": str(self.psd), "wav": str(self.wav), "fingerprint": meta["fingerprint"],
            "layers": base, "mode": "none", "blink_enabled": False,
            "output_dir": str(self.root), "basename": "speech", "fps": 30,
        }

    def post(self, **changes):
        return self.client.post("/api/preset-utterance-export",
                                json={**self.body, **changes})

    def test_destination_probe_is_non_mutating(self):
        response = self.client.post("/api/preset-utterance-destination",
                                    json={"output_dir": str(self.root),
                                          "basename": "speech"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["state"], "available")
        (self.root / "speech.mov").write_bytes(b"preserve")
        response = self.client.post("/api/preset-utterance-destination",
                                    json={"output_dir": str(self.root),
                                          "basename": "speech"})
        self.assertEqual(response.json()["state"], "partial")
        self.assertEqual(response.json()["suggested_basename"], "speech_002")
        self.assertEqual((self.root / "speech.mov").read_bytes(), b"preserve")
        self.assertEqual(self.post(conflict_policy="overwrite").status_code, 400)
        self.assertEqual((self.root / "speech.mov").read_bytes(), b"preserve")

    def test_invalid_mode_snapshot_and_destination_do_not_publish(self):
        for changes in (
            {"mode": "aiueo"},
            {"mode": "open"},
            {"blink_enabled": True},
            {"fingerprint": "stale"},
            {"layers": self.body["layers"][:-1]},
            {"basename": "../escape"},
            {"fps": 29},
            {"conflict_policy": "not-supported"},
        ):
            with self.subTest(changes=changes):
                response = self.post(**changes)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(set(self.root.iterdir()), {self.psd, self.wav})
        self.assertEqual(self.post(mode="aiueo", blink_enabled=True).status_code, 400)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_none_and_open_produce_pcm_mov_with_embedded_audio_reference(self):
        originals = (self.psd.read_bytes(), self.wav.read_bytes())
        static = self.post()
        self.assertEqual(static.status_code, 200, static.text)
        self.assertEqual(static.json()["frames"], 4)
        closed, opened = self.closed, self.opened
        shape = {
            "closed": [{"path": closed, "visible": True},
                       {"path": opened, "visible": False}],
            "opened": [{"path": closed, "visible": False},
                       {"path": opened, "visible": True}],
        }
        response = self.post(mode="open", mouth=shape, basename="lip_open")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["frames"], 4)
        for basename in ("speech", "lip_open"):
            otio = json.loads((self.root / (basename + ".otio")).read_text("utf-8"))
            tracks = otio["tracks"]["children"]
            self.assertEqual(len(tracks), 2)
            reference = tracks[1]["children"][0]["media_references"]["DEFAULT_MEDIA"]
            self.assertEqual(reference["target_url"], str((self.root / (basename + ".mov")).resolve()))
            self.assertEqual(reference["name"], basename + ".mov")
            self.assertTrue((self.root / (basename + ".mov")).is_file())
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), originals)
        self.assertEqual(self.post().status_code, 400)
        # Explicit overwrite maintains stable MOV/OTIO paths in the result.
        old_otio = (self.root / "speech.otio").read_bytes()
        replaced = self.post(conflict_policy="overwrite")
        self.assertEqual(replaced.status_code, 200, replaced.text)
        self.assertEqual(replaced.json()["mov"], str((self.root / "speech.mov").resolve()))
        self.assertEqual(replaced.json()["otio"], str((self.root / "speech.otio").resolve()))
        video_ref = json.loads((self.root / "speech.otio").read_text("utf-8"))[
            "tracks"]["children"][0]["children"][0]["media_references"]["DEFAULT_MEDIA"]
        self.assertEqual(video_ref["name"], "speech.mov")
        self.assertEqual(video_ref["target_url"], (self.root / "speech.mov").resolve().as_uri())
        self.assertTrue((self.root / "speech.otio").read_bytes())
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), originals)
        self.assertFalse((self.root / ".speech.tachie-backup").exists())
        # The alternative uses a fresh pair and does not touch the existing one.
        snapshot = ((self.root / "speech.mov").read_bytes(),
                    (self.root / "speech.otio").read_bytes())
        separate = self.post(basename="speech_002")
        self.assertEqual(separate.status_code, 200, separate.text)
        self.assertEqual(snapshot, ((self.root / "speech.mov").read_bytes(),
                                    (self.root / "speech.otio").read_bytes()))

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_temp_cleanup_failure_after_publish_returns_http_200_and_warning(self):
        from unittest.mock import patch
        original_cleanup = tempfile.TemporaryDirectory.cleanup

        def fail_cleanup(instance):
            original_cleanup(instance)
            if Path(instance.name).name.startswith(".tachie-preset-"):
                raise OSError("synthetic cleanup failure")

        originals = (self.psd.read_bytes(), self.wav.read_bytes())
        with patch("tachie_motion.web.preset_utterance.tempfile.TemporaryDirectory.cleanup",
                   autospec=True, side_effect=fail_cleanup):
            created = self.post()
            self.assertEqual(created.status_code, 200, created.text)
            self.assertIn("temporary render files", created.json()["warning"])
            self.assertTrue((self.root / "speech.mov").is_file())
            self.assertTrue((self.root / "speech.otio").is_file())
            overwritten = self.post(conflict_policy="overwrite")
            self.assertEqual(overwritten.status_code, 200, overwritten.text)
            self.assertIn("temporary render files", overwritten.json()["warning"])
            self.assertTrue((self.root / "speech.mov").is_file())
            self.assertTrue((self.root / "speech.otio").is_file())
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), originals)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_mux_failure_leaves_new_and_existing_pairs_untouched(self):
        from unittest.mock import patch

        originals = (self.psd.read_bytes(), self.wav.read_bytes())
        with patch(
            "tachie_motion.web.preset_utterance.mux_verified_pcm",
            side_effect=RuntimeError("synthetic PCM mux failure"),
        ):
            failed = self.post()
        self.assertEqual(failed.status_code, 400, failed.text)
        self.assertEqual(set(self.root.iterdir()), {self.psd, self.wav})
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), originals)

        created = self.post()
        self.assertEqual(created.status_code, 200, created.text)
        mov, otio = self.root / "speech.mov", self.root / "speech.otio"
        existing_pair = (mov.read_bytes(), otio.read_bytes())
        with patch(
            "tachie_motion.web.preset_utterance.mux_verified_pcm",
            side_effect=RuntimeError("synthetic PCM mux failure"),
        ):
            failed = self.post(conflict_policy="overwrite")
        self.assertEqual(failed.status_code, 400, failed.text)
        self.assertEqual((mov.read_bytes(), otio.read_bytes()), existing_pair)
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), originals)
        self.assertFalse((self.root / ".speech.tachie-backup").exists())

    def test_abandoned_new_export_recovery_is_visible_and_blocks_api(self):
        recovery = self.root / ".speech.failed-simulated"
        recovery.mkdir()
        (recovery / "candidate.mov").write_bytes(b"EXTERNAL")
        probe = self.client.post("/api/preset-utterance-destination",
                                 json={"output_dir": str(self.root),
                                       "basename": "speech"})
        self.assertEqual(probe.status_code, 200, probe.text)
        self.assertEqual(probe.json()["state"], "recovery_required")
        self.assertEqual(probe.json()["suggested_basename"], "speech_002")
        denied = self.post()
        self.assertEqual(denied.status_code, 400, denied.text)
        self.assertIn("needs recovery", denied.text)
        self.assertEqual((recovery / "candidate.mov").read_bytes(), b"EXTERNAL")
        self.assertFalse((self.root / "speech.mov").exists())
        self.assertFalse((self.root / "speech.otio").exists())
