"""Issue #27: synthetic six-mouth video, source safety and LAB policy tests."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tachie_motion.audio.aiueo_frames import MOV_POLICY, schedule_aiueo
from tachie_motion.audio.lab import LabInterval
from tachie_motion.psd.visibility import parse_index_path
from tachie_motion.web.aiueo_renderer import (
    aiueo_indices, inspect_export_lab, render_aiueo_states, validate_aiueo_mouth,
)
from tachie_motion.web.preset_utterance import validated_snapshot
from tachie_motion.web.service import describe_psd, describe_wav, describe_wav_lab
from test_web_api import fixture

try:
    from fastapi.testclient import TestClient
    import httpx2  # noqa: F401
except (ImportError, RuntimeError):
    TestClient = None


def six_shapes(closed: str, opened: str) -> dict:
    return {
        key: [{"path": closed, "visible": key not in ("a", "u", "o")},
              {"path": opened, "visible": key in ("a", "u", "o")}]
        for key in ("a", "i", "u", "e", "o", "n")
    }


class AiueoCoreTests(unittest.TestCase):
    def test_approved_policy_and_unsampled_short_vowel(self):
        self.assertEqual((MOV_POLICY.anchor, MOV_POLICY.consonants, MOV_POLICY.devoiced),
                         ("middle", "anticipate_next", "vowel"))
        # The central 30-fps sample falls within consonant k, while the
        # following vowel is too brief to fall on ANY sampled video frame.
        intervals = (
            LabInterval(0, 200000, "k"),
            LabInterval(200000, 210000, "A"),
            LabInterval(210000, 500000, "sil"),
        )
        # Frame 0 middle sample 1/60s = 166666 ticks, inside k.
        self.assertEqual(schedule_aiueo(
            intervals, samples=400, sample_rate=1000, fps=30, policy=MOV_POLICY,
        )[0], "a")

    def test_all_states_start_from_base_and_persist_no_previous_override(self):
        with tempfile.TemporaryDirectory() as root:
            psd_path, wav, closed, opened = fixture(Path(root))
            metadata = describe_psd(str(psd_path))
            base = [{"path": entry["path"], "visible": entry["visible"]}
                    for entry in metadata["layers"]]
            psd, visibility = validated_snapshot(psd_path, metadata["fingerprint"], base)
            from PIL import Image
            from tachie_motion.psd.crop import write_fixed_crop_png

            mouth = six_shapes(closed, opened)
            mouth["n"] = []  # Rest uses the preset's unmodified base state.
            shapes = validate_aiueo_mouth(
                psd, visibility, mouth,
                [closed.rsplit("/", 1)[0]],
            )
            original = psd_path.read_bytes()
            reference = Path(root) / "reference-rest.png"
            write_fixed_crop_png(psd, reference, padding=16)
            outputs = render_aiueo_states(psd, visibility, shapes, Path(root))
            with Image.open(reference) as base_img, Image.open(outputs[-1]) as n_img:
                self.assertEqual(base_img.convert("RGBA").tobytes(),
                                 n_img.convert("RGBA").tobytes())
            self.assertEqual(len(outputs), 6)
            self.assertNotEqual(outputs[0].read_bytes(), outputs[1].read_bytes())
            self.assertEqual(outputs[1].read_bytes(), outputs[3].read_bytes())
            self.assertEqual(psd_path.read_bytes(), original)

    def test_incomplete_shapes_outside_groups_hidden_parents_and_choice(self):
        with tempfile.TemporaryDirectory() as root:
            psd_path, wav, closed, opened = fixture(Path(root))
            meta = describe_psd(str(psd_path))
            base = [{"path": entry["path"], "visible": entry["visible"]}
                    for entry in meta["layers"]]
            psd, visibility = validated_snapshot(psd_path, meta["fingerprint"], base)
            shapes = six_shapes(closed, opened)
            self.assertEqual(
                validate_aiueo_mouth(psd, visibility, {**shapes, "n": []},
                                     [closed.rsplit("/", 1)[0]])["n"],
                {},
            )
            with self.assertRaisesRegex(ValueError, "configured"):
                validate_aiueo_mouth(psd, visibility, {**shapes, "a": []})
            with self.assertRaisesRegex(ValueError, "six-shape"):
                validate_aiueo_mouth(psd, visibility, {
                    key: value for key, value in shapes.items() if key != "n"
                })
            with self.assertRaisesRegex(ValueError, "assigned"):
                validate_aiueo_mouth(psd, visibility, shapes, [])
            # An assigned mouth group must not admit an unrelated root leaf.
            other_leaf = next(item for item in visibility
                              if item not in (parse_index_path(closed), parse_index_path(opened))
                              and len(item) == 1 and item != parse_index_path(closed.rsplit("/", 1)[0]))
            with self.assertRaisesRegex(ValueError, "outside"):
                validate_aiueo_mouth(psd, visibility, {
                    **shapes, "a": [{"path": "/".join(map(str, other_leaf)), "visible": True}],
                }, [closed.rsplit("/", 1)[0]])
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                validate_aiueo_mouth(psd, visibility, {
                    **shapes, "a": [shapes["a"][0], shapes["a"][0]],
                })
            with self.assertRaisesRegex(ValueError, "hidden parent"):
                validate_aiueo_mouth(psd, {
                    **visibility, parse_index_path(closed.rsplit("/", 1)[0]): False,
                }, shapes, [closed.rsplit("/", 1)[0]])


    def test_psdtool_sibling_radio_and_mandatory_leaf_guards(self):
        from PIL import Image
        from psd_tools import PSDImage
        from tachie_motion.psd.tree import walk_layers

        psd = PSDImage.new(mode="RGB", size=(32, 32), depth=8)
        group = psd.create_group(name="mouth")
        for name in ("*A", "*B", "!fixed"):
            group.create_pixel_layer(
                Image.new("RGBA", (3, 3), (100, 120, 140, 255)),
                name=name, left=2, top=2,
            )
        by_name = {summary.name: summary for summary in walk_layers(psd)}
        selected = by_name["*A"].index_path
        other = by_name["*B"].index_path
        fixed = by_name["!fixed"].index_path
        parent = selected[:-1]
        base = {summary.index_path: (summary.index_path != other)
                for summary in walk_layers(psd)}
        def entry(path, visible):
            return {"path": "/".join(map(str, path)), "visible": visible}
        shapes = {key: [entry(selected, True)]
                  for key in ("a", "i", "u", "e", "o", "n")}
        group_path = ["/".join(map(str, parent))]
        validate_aiueo_mouth(psd, base, shapes, group_path)
        with self.assertRaisesRegex(ValueError, "exclusive"):
            validate_aiueo_mouth(psd, base, {
                **shapes, "a": [entry(other, True)],
            }, group_path)
        with self.assertRaisesRegex(ValueError, "mandatory"):
            validate_aiueo_mouth(psd, base, {
                **shapes, "i": [entry(fixed, False)],
            }, group_path)


@unittest.skipUnless(TestClient is not None, "httpx test extra required")
class AiueoApiTests(unittest.TestCase):
    def setUp(self):
        from tachie_motion.web.app import app
        self.client = TestClient(app, base_url="http://127.0.0.1:8765")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.psd, self.wav, closed, opened = fixture(self.root)
        metadata = describe_psd(str(self.psd))
        self.lab = self.wav.with_suffix(".lab")
        self.lab.write_text("0 220000 k\n220000 600000 a\n600000 1010000 i\n", encoding="utf-8")
        lab_token = describe_wav_lab(str(self.wav),
            describe_wav(str(self.wav))["source_identity"])["source_identity"]
        self.body = {
            "lab_source_identity": lab_token,
            "psd": str(self.psd), "wav": str(self.wav),
            "source_identity": describe_wav(str(self.wav))["source_identity"],
            "fingerprint": metadata["fingerprint"],
            "layers": [{"path": x["path"], "visible": x["visible"]}
                       for x in metadata["layers"]],
            "mouth": None, "aiueo_mouth": six_shapes(closed, opened),
            "mouth_groups": [closed.rsplit("/", 1)[0]],
            "mode": "aiueo", "blink_enabled": False,
            "output_dir": str(self.root), "basename": "speech",
            "fps": 30, "conflict_policy": "error",
        }

    def post(self, **changes):
        return self.client.post("/api/preset-utterance-export",
                                json={**self.body, **changes})

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_real_pcm_mov_four_frames_aiueo_pose_diff_and_otio(self):
        original = (self.psd.read_bytes(), self.wav.read_bytes(), self.lab.read_bytes())
        response = self.post(aiueo_mouth={**self.body["aiueo_mouth"], "n": []})
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["frames"], 4)
        self.assertEqual(result["sample_count"], 101)
        mov = Path(result["mov"])
        self.assertTrue(mov.is_file())
        doc = json.loads(Path(result["otio"]).read_text("utf-8"))
        track_refs = [
            track["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"]
            for track in doc["tracks"]["children"]
        ]
        self.assertEqual(track_refs, [mov.resolve().as_uri(), str(mov.resolve())])
        probe = subprocess.run([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0", str(mov),
        ], check=True, stdout=subprocess.PIPE, text=True)
        width, height = (int(n) for n in probe.stdout.strip().split(","))
        decoded = subprocess.run([
            "ffmpeg", "-v", "error", "-i", str(mov), "-map", "0:v:0",
            "-pix_fmt", "rgba", "-f", "rawvideo", "-",
        ], check=True, stdout=subprocess.PIPE)
        stride = width * height * 4
        self.assertEqual(len(decoded.stdout), stride * 4)
        frames = [decoded.stdout[i * stride:(i + 1) * stride] for i in range(4)]
        self.assertNotEqual(frames[0], frames[2])
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes(), self.lab.read_bytes()),
                         original)

    def test_reject_missing_invalid_and_unconfigured_lab_without_files(self):
        original = (self.psd.read_bytes(), self.wav.read_bytes())
        self.lab.unlink()
        self.assertEqual(self.post().status_code, 400)
        self.lab.write_text("0 1010000 unknown\n", encoding="utf-8")
        self.assertEqual(self.post().status_code, 400)
        self.lab.write_text("0 1010000 a\n", encoding="utf-8")
        self.assertEqual(self.post(aiueo_mouth=None).status_code, 400)
        self.assertEqual(self.post(mouth_groups=["999"]).status_code, 400)
        self.assertEqual(self.post(blink_enabled=True).status_code, 400)
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), original)
        self.assertFalse((self.root / "speech.mov").exists())
        self.assertFalse((self.root / "speech.otio").exists())

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_lab_modified_during_export_blocks_publication(self):
        from tachie_motion.render.sequence import encode_prores_sequence
        original = (self.psd.read_bytes(), self.wav.read_bytes())
        initial = self.lab.read_bytes()

        def mutate_after_encode(*args, **kwargs):
            report = encode_prores_sequence(*args, **kwargs)
            self.lab.write_text("0 1010000 o\n", encoding="utf-8")
            return report

        with patch("tachie_motion.web.preset_utterance.encode_prores_sequence",
                   side_effect=mutate_after_encode):
            response = self.post()
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("LAB changed", response.text)
        self.assertFalse((self.root / "speech.mov").exists())
        self.assertFalse((self.root / "speech.otio").exists())
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), original)
        self.assertNotEqual(self.lab.read_bytes(), initial)


if __name__ == "__main__":
    unittest.main()
