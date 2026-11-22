"""Pure safety tests for the selective MOV cache identities (Issue #62)."""

from pathlib import Path
import os
import tempfile
import unittest

from tachie_motion.web.selective_recipe import (
    digest_regular_file, fingerprint_render_recipe,
)


class SelectiveRecipeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.psd = root / "あんこもん.psd"
        self.wav = root / "せりふ.wav"
        self.lab = root / "せりふ.lab"
        self.mov = root / "公開.mov"
        self.psd.write_bytes(b"PSD frame bytes")
        self.wav.write_bytes(b"WAV audio bytes")
        self.lab.write_bytes(b"LAB intervals")
        self.mov.write_bytes(b"PCM ProRes content")
        self.payload = {
            "psd": str(self.psd), "wav": str(self.wav),
            "fingerprint": "15:1", "source_identity": "1:2:3:4:5",
            "layers": [{"path": "0/2", "visible": True}],
            "mode": "none", "blink_enabled": False, "fps": 30,
            "mouth": None, "aiueo_mouth": None, "mouth_groups": None,
            "lab_source_identity": None, "eyes": None, "eye_groups": None,
            "blink_timing": None, "timeline_changes": [],
            "output_dir": str(root), "basename": "001_test",
            "conflict_policy": "error", "progress_id": "progress-1",
        }

    def key(self, payload=None, lab=False, revision="renderer1"):
        return fingerprint_render_recipe(
            payload or self.payload, psd=digest_regular_file(self.psd),
            wav=digest_regular_file(self.wav),
            lab=digest_regular_file(self.lab) if lab else None,
            engine_revision=revision,
        )

    def test_output_path_order_conflict_and_transport_do_not_affect_pixels(self):
        original = self.key()
        changed = dict(reversed(list(self.payload.items())))
        changed.update(output_dir="/different", basename="002_other",
                       conflict_policy="overwrite", progress_id="other",
                       batch_id="job2", batch_index=10)
        self.assertEqual(original, self.key(changed))

    def test_render_inputs_invalidate_only_the_affected_recipe(self):
        original = self.key()
        modifications = [
            {"fps": 60}, {"mode": "open"}, {"fingerprint": "15:2"},
            {"source_identity": "1:2:3:4:6"},
            {"layers": [{"path": "0/2", "visible": False}]},
            {"blink_enabled": True, "blink_timing": {"jitter_frames": 7}},
            {"mouth_groups": ["0"]},
            {"timeline_changes": [{"sample": 1, "preset_id": "a", "mode": "open"}]},
        ]
        for patch in modifications:
            with self.subTest(patch=patch):
                self.assertNotEqual(original, self.key({**self.payload, **patch}))
        self.assertNotEqual(original, self.key(revision="renderer2"))

    def test_source_bytes_invalidate_even_if_size_and_mtime_are_unchanged(self):
        initial = self.key()
        for path in (self.psd, self.wav):
            old = path.stat()
            data = path.read_bytes()
            path.write_bytes(bytes([data[0] ^ 1]) + data[1:])
            os.utime(path, ns=(old.st_atime_ns, old.st_mtime_ns))
            self.assertNotEqual(initial, self.key())
            path.write_bytes(data)

    def test_aiueo_requires_lab_bytes_and_lab_mutation_invalidates(self):
        p = {**self.payload, "mode": "aiueo", "lab_source_identity": "1:2:3:4:5"}
        with self.assertRaisesRegex(ValueError, "LAB content"):
            self.key(p)
        initial = self.key(p, lab=True)
        self.lab.write_bytes(b"CHANGED intervals")
        self.assertNotEqual(initial, self.key(p, lab=True))
        with self.assertRaisesRegex(ValueError, "LAB content"):
            self.key(self.payload, lab=True)

    def test_unknown_fields_invalid_json_and_missing_sources_fail_closed(self):
        for p in ({**self.payload, "future_renderer_option": True},
                  {k: v for k, v in self.payload.items() if k != "fps"}):
            with self.assertRaisesRegex(ValueError, "recipe field"):
                self.key(p)
        with self.assertRaisesRegex(ValueError, "recipe data"):
            self.key({**self.payload, "layers": [{"visible": float("nan")}]})
        self.wav.unlink()
        with self.assertRaises(FileNotFoundError):
            self.key()

    def test_mov_digest_detects_external_changes_and_refuses_symlinks(self):
        first = digest_regular_file(self.mov)
        self.mov.write_bytes(b"third-party replacement")
        self.assertNotEqual(first.sha256, digest_regular_file(self.mov).sha256)
        self.mov.unlink()
        self.mov.symlink_to(self.wav)
        with self.assertRaisesRegex(ValueError, "regular file"):
            digest_regular_file(self.mov)


if __name__ == "__main__":
    unittest.main()
