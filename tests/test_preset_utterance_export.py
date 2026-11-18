"""Preset-backed one-WAV export: real synthetic PSD/WAV, no user media."""

import subprocess
from pathlib import Path
from PIL import Image
import shutil
import tempfile
import unittest

from tachie_motion.web.preset_utterance import (
    validated_snapshot, validate_open_mouth,
)
from tachie_motion.psd.visibility import parse_index_path
from tachie_motion.web.service import describe_psd, describe_wav, describe_wav
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
            # Explicit selection may match the fixed-layer pose exactly.
            same = validate_open_mouth(image, visibility, {
                "closed": [{"path": closed, "visible": True}],
                "opened": [{"path": closed, "visible": True}],
            })
            self.assertTrue(same["opened"][parse_index_path(closed)])
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
            "source_identity": describe_wav(str(self.wav))["source_identity"],
        }

    def post(self, **changes):
        return self.client.post("/api/preset-utterance-export",
                                json={**self.body, **changes})

    def test_api_rejects_identity_omission_before_overwrite(self):
        mov = self.root / "speech.mov"
        otio = self.root / "speech.otio"
        mov.write_bytes(b"prior MOV")
        otio.write_bytes(b"prior OTIO")
        no_identity = {key: value for key, value in self.body.items()
                       if key != "source_identity"}
        response = self.client.post("/api/preset-utterance-export",
                                    json={**no_identity, "conflict_policy": "overwrite"})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(mov.read_bytes(), b"prior MOV")
        self.assertEqual(otio.read_bytes(), b"prior OTIO")

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
        self.assertEqual(response.json()["state"], "complete")
        self.assertEqual(response.json()["suggested_basename"], "speech_002")
        self.assertEqual((self.root / "speech.mov").read_bytes(), b"preserve")
        self.assertEqual(self.post().status_code, 400)
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

    def test_open_api_rejects_psdtool_conflicts_without_publishing(self):
        from psd_tools import PSDImage

        psd = PSDImage.new(mode="RGB", size=(32, 32), depth=8)
        mouth = psd.create_group(name="mouth")
        for name in ("*A", "*B", "!fixed"):
            mouth.create_pixel_layer(
                Image.new("RGBA", (4, 4), (120, 180, 200, 255)),
                name=name, left=2, top=2,
            )
        source = self.root / "psdtool.psd"
        psd.save(source)
        meta = describe_psd(str(source))
        base = [{"path": layer["path"], "visible": layer["name"] != "*B"}
                for layer in meta["layers"]]
        by_name = {layer["name"]: layer["path"] for layer in meta["layers"]}
        a, b, mandatory = (by_name[name] for name in ("*A", "*B", "!fixed"))
        parent = by_name["mouth"]
        closed = [{"path": a, "visible": True},
                  {"path": b, "visible": False}]
        valid_open = [{"path": a, "visible": True},
                      {"path": b, "visible": False}]
        destination_mov = self.root / "speech.mov"
        destination_mov.write_bytes(b"original MOV")
        original_psd = source.read_bytes()
        cases = [
            (base, [{"path": a, "visible": True}, {"path": b, "visible": True}]),
            ([{**entry, "visible": False} if entry["path"] == mandatory else entry
              for entry in base], valid_open),
            ([{**entry, "visible": True} if entry["path"] == b else entry
              for entry in base], valid_open),
        ]
        for fixed_layers, active in cases:
            with self.subTest(active=active, base=fixed_layers):
                response = self.post(
                    mode="open", psd=str(source), fingerprint=meta["fingerprint"],
                    layers=fixed_layers, mouth_groups=[parent],
                    mouth={"closed": closed, "opened": active},
                    conflict_policy="overwrite",
                )
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(destination_mov.read_bytes(), b"original MOV")
                self.assertFalse((self.root / "speech.otio").exists())
                self.assertEqual(source.read_bytes(), original_psd)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_none_and_open_produce_pcm_mov_without_individual_otio(self):
        originals = (self.psd.read_bytes(), self.wav.read_bytes())
        static = self.post()
        self.assertEqual(static.status_code, 200, static.text)
        self.assertEqual(static.json()["frames"], 4)
        self.assertNotIn("otio", static.json())
        shape = {
            "closed": [{"path": self.closed, "visible": True},
                       {"path": self.opened, "visible": False}],
            "opened": [{"path": self.closed, "visible": False},
                       {"path": self.opened, "visible": True}],
        }
        response = self.post(mode="open", mouth=shape, basename="lip_open")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["frames"], 4)
        for basename in ("speech", "lip_open"):
            mov = self.root / (basename + ".mov")
            self.assertTrue(mov.is_file())
            self.assertFalse((self.root / (basename + ".otio")).exists())
            codec = subprocess.run([
                "ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(mov),
            ], check=True, capture_output=True, text=True).stdout.strip()
            self.assertEqual(codec, "pcm_s16le")
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), originals)
        self.assertEqual(self.post().status_code, 400)
        replaced = self.post(conflict_policy="overwrite")
        self.assertEqual(replaced.status_code, 200, replaced.text)
        self.assertEqual(replaced.json()["mov"], str((self.root / "speech.mov").resolve()))
        self.assertNotIn("otio", replaced.json())
        self.assertTrue((self.root / "speech.mov").is_file())
        self.assertFalse((self.root / "speech.otio").exists())
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), originals)
        self.assertFalse((self.root / ".speech.mov.single-backup").exists())
        previous = (self.root / "speech.mov").read_bytes()
        separate = self.post(basename="speech_002")
        self.assertEqual(separate.status_code, 200, separate.text)
        self.assertEqual((self.root / "speech.mov").read_bytes(), previous)
        self.assertFalse((self.root / "speech_002.otio").exists())

    def test_existing_legacy_otio_blocks_solo_overwrite_and_offers_safe_name(self):
        old_mov = self.root / "speech.mov"
        old_otio = self.root / "speech.otio"
        old_mov.write_bytes(b"OLD MOV")
        old_otio.write_bytes(b"OLD OTIO")
        probe = self.client.post("/api/preset-utterance-destination",
                                 json={"output_dir": str(self.root), "basename": "speech"})
        self.assertEqual(probe.status_code, 200, probe.text)
        self.assertEqual(probe.json()["state"], "unsafe")
        self.assertEqual(probe.json()["suggested_basename"], "speech_002")
        denied = self.post(conflict_policy="overwrite")
        self.assertEqual(denied.status_code, 400, denied.text)
        self.assertEqual(old_mov.read_bytes(), b"OLD MOV")
        self.assertEqual(old_otio.read_bytes(), b"OLD OTIO")
        self.assertFalse((self.root / "speech_002.mov").exists())

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_open_closed_frame_uses_base_even_with_legacy_opposite_override(self):
        from unittest.mock import patch
        from tachie_motion.psd.visibility import parse_index_path, resolve_layer
        from tachie_motion.web.preset_utterance import write_fixed_crop_png

        seen = []
        closed = parse_index_path(self.closed)
        opened = parse_index_path(self.opened)

        def observe(psd, destination, **kwargs):
            seen.append((resolve_layer(psd, closed).visible,
                         resolve_layer(psd, opened).visible))
            return write_fixed_crop_png(psd, destination, **kwargs)

        # Legacy closed is deliberately opposite the current fixed state.
        # It must stay in the payload for compatibility, not affect playback.
        legacy = {
            "closed": [{"path": self.closed, "visible": False},
                       {"path": self.opened, "visible": True}],
            "opened": [{"path": self.closed, "visible": False},
                       {"path": self.opened, "visible": True}],
        }
        with patch("tachie_motion.web.preset_utterance.write_fixed_crop_png",
                   side_effect=observe):
            response = self.post(mode="open", mouth=legacy, basename="fixed_close")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(seen, [(True, False), (False, True)])

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
            self.assertFalse((self.root / "speech.otio").exists())
            overwritten = self.post(conflict_policy="overwrite")
            self.assertEqual(overwritten.status_code, 200, overwritten.text)
            self.assertIn("temporary render files", overwritten.json()["warning"])
            self.assertTrue((self.root / "speech.mov").is_file())
            self.assertFalse((self.root / "speech.otio").exists())
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), originals)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_mux_failure_leaves_new_and_existing_single_mov_untouched(self):
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
        mov = self.root / "speech.mov"
        existing_mov = mov.read_bytes()
        with patch(
            "tachie_motion.web.preset_utterance.mux_verified_pcm",
            side_effect=RuntimeError("synthetic PCM mux failure"),
        ):
            failed = self.post(conflict_policy="overwrite")
        self.assertEqual(failed.status_code, 400, failed.text)
        self.assertEqual(mov.read_bytes(), existing_mov)
        self.assertFalse((self.root / "speech.otio").exists())
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), originals)
        self.assertFalse((self.root / ".speech.tachie-backup").exists())

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_replaced_wav_with_same_timing_cannot_publish_web_mov(self):
        from unittest.mock import patch
        from tachie_motion.render.pcm_mux import mux_verified_pcm

        before = self.wav.read_bytes()

        def switch_wav_before_mux(video, source, target, **kwargs):
            payload = bytearray(source.read_bytes())
            payload[-1] ^= 1  # Same RIFF length, channel layout and sample count.
            source.write_bytes(payload)  # Simulate an external writer.
            return mux_verified_pcm(video, source, target, **kwargs)

        with patch(
            "tachie_motion.web.preset_utterance.mux_verified_pcm",
            side_effect=switch_wav_before_mux,
        ):
            response = self.post()
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("PCM changed after animation", response.text)
        self.assertEqual(len(self.wav.read_bytes()), len(before))
        self.assertFalse((self.root / "speech.mov").exists())
        self.assertFalse((self.root / "speech.otio").exists())
        self.assertFalse(list(self.root.glob(".speech.failed-*")))

    def test_project_wav_identity_mismatch_denies_export_before_render(self):
        original_identity = describe_wav(str(self.wav))["source_identity"]
        payload = bytearray(self.wav.read_bytes())
        payload[-1] ^= 1
        self.wav.write_bytes(payload)
        self.assertNotEqual(original_identity, describe_wav(str(self.wav))["source_identity"])
        denied = self.post(source_identity=original_identity)
        self.assertEqual(denied.status_code, 400, denied.text)
        self.assertIn("WAV changed since registration", denied.text)
        self.assertFalse((self.root / "speech.mov").exists())
        self.assertFalse((self.root / "speech.otio").exists())

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_project_wav_change_after_mux_denies_publish_without_outputs(self):
        from unittest.mock import patch
        from tachie_motion.render.pcm_mux import mux_verified_pcm

        original_identity = describe_wav(str(self.wav))["source_identity"]

        def replace_wav_after_mux(*args, **kwargs):
            report = mux_verified_pcm(*args, **kwargs)
            payload = bytearray(self.wav.read_bytes())
            payload[-1] ^= 1
            self.wav.write_bytes(payload)
            return report

        with patch("tachie_motion.web.preset_utterance.mux_verified_pcm",
                   side_effect=replace_wav_after_mux):
            denied = self.post(source_identity=original_identity)
        self.assertEqual(denied.status_code, 400, denied.text)
        self.assertIn("WAV changed since registration", denied.text)
        self.assertFalse((self.root / "speech.mov").exists())
        self.assertFalse((self.root / "speech.otio").exists())

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_project_wav_identity_accepts_unchanged_file(self):
        original_identity = describe_wav(str(self.wav))["source_identity"]
        accepted = self.post(source_identity=original_identity)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertTrue((self.root / "speech.mov").is_file())
        self.assertFalse((self.root / "speech.otio").exists())

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
