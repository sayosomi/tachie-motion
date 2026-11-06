"""Synthetic PSD tests of read-only unified preset base previews."""

import base64
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from psd_tools import PSDImage

from tachie_motion.web.preset_preview import preview_base_preset, _cached_render
from tachie_motion.web.service import describe_psd


class PresetPreviewTests(unittest.TestCase):
    def setUp(self):
        # Keep the existing exact-PNG-LRU tests independent of the new frame
        # optimization. Dedicated tests exercise the eligible fast path.
        self.roi_disabled = patch(
            "tachie_motion.web.preview_frame.is_roi_safe", return_value=False,
        )
        self.roi_disabled.start()
        self.addCleanup(self.roi_disabled.stop)
        _cached_render.cache_clear()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "キャラ た\u3099んもん.psd"
        psd = PSDImage.new(mode="RGB", size=(48, 48), depth=8)
        group = psd.create_group(name="eyes")
        group.create_pixel_layer(
            Image.new("RGBA", (20, 14), (200, 45, 70, 255)),
            name="duplicate", left=7, top=8,
        )
        group.create_pixel_layer(
            Image.new("RGBA", (20, 14), (50, 150, 240, 255)),
            name="duplicate", left=7, top=8,
        ).visible = False
        psd.save(self.source)
        self.original = self.source.read_bytes()
        self.info = describe_psd(str(self.source))
        self.states = [
            {"path": layer["path"], "visible": layer["visible"]}
            for layer in self.info["layers"]
        ]

    def preview(self, states=None, token=None):
        return preview_base_preset(
            str(self.source), token or self.info["fingerprint"],
            self.states if states is None else states,
        )["preview"]

    def test_base_preview_matches_initial_source_and_changed_layer(self):
        initial = self.preview()
        self.assertEqual(initial, self.info["preview"])
        new_states = [dict(x) for x in self.states]
        on_path = next(x["path"] for x in new_states if not x["visible"])
        off_path = next(x["path"] for x in new_states if x["visible"] and "/" in x["path"])
        for state in new_states:
            if state["path"] == on_path:
                state["visible"] = True
            if state["path"] == off_path:
                state["visible"] = False
        updated = self.preview(new_states)
        self.assertNotEqual(
            base64.b64decode(initial.split(",", 1)[1]),
            base64.b64decode(updated.split(",", 1)[1]),
        )
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_hidden_parent_does_not_implicitly_change_child_visibility(self):
        updated = [dict(x) for x in self.states]
        updated[0]["visible"] = False
        # The child stays ON even when its group is OFF. Rendering it is
        # allowed, but no implicit parent/group override is inferred.
        self.assertTrue(updated[1]["visible"])
        self.assertTrue(self.preview(updated).startswith("data:image/png;base64,"))
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_reject_invalid_incomplete_stale_and_duplicate_states(self):
        cases = [
            self.states[:-1],
            self.states + [dict(self.states[0])],
            [dict(self.states[0], path="99")] + self.states[1:],
            [dict(self.states[0], visible="true")] + self.states[1:],
            [dict(self.states[0], path="not/a/path")] + self.states[1:],
        ]
        for states in cases:
            with self.subTest(states=states), self.assertRaises(ValueError):
                self.preview(states)
        with self.assertRaisesRegex(ValueError, "changed"):
            self.preview(token="0:1")
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_source_snapshot_mtime_change_rejected(self):
        before = self.source.stat()
        os.utime(self.source, ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000))
        with self.assertRaisesRegex(ValueError, "changed"):
            self.preview()
        self.assertEqual(self.source.read_bytes(), self.original)


    def test_exact_state_png_cache_reuses_results_without_mutating_source(self):
        import tachie_motion.web.preset_preview as preview_module

        real_thumbnail = preview_module.thumbnail
        with patch.object(preview_module, "thumbnail", wraps=real_thumbnail) as render:
            base = self.preview()
            other = [dict(state) for state in self.states]
            other[2]["visible"] = not other[2]["visible"]
            changed = self.preview(other)
            self.assertNotEqual(base, changed)
            self.assertEqual(self.preview(), base)
            self.assertEqual(self.preview(other), changed)
            self.assertEqual(render.call_count, 2)
            # Different input list order represents the same full state.
            self.assertEqual(self.preview(list(reversed(other))), changed)
            self.assertEqual(render.call_count, 2)
        stats = _cached_render.cache_info()
        self.assertEqual(stats.misses, 2)
        self.assertGreaterEqual(stats.hits, 3)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_cache_key_separates_other_source_and_same_mtime_file_replacement(self):
        import tachie_motion.web.preset_preview as preview_module

        real_thumbnail = preview_module.thumbnail
        other = Path(self.temp.name) / "other.psd"
        other.write_bytes(self.original)
        before = self.source.stat()
        os.utime(other, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.source.stat().st_size, other.stat().st_size)

        with patch.object(preview_module, "thumbnail", wraps=real_thumbnail) as render:
            base = self.preview()
            self.assertEqual(preview_base_preset(
                str(other), self.info["fingerprint"], self.states,
            )["preview"], base)
            self.assertEqual(render.call_count, 2)

            replacement = Path(self.temp.name) / "replacement.psd"
            replacement.write_bytes(self.original)
            os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
            os.replace(replacement, self.source)
            self.assertNotEqual(before.st_ino, self.source.stat().st_ino)
            self.assertEqual(self.preview(), base)
            self.assertEqual(render.call_count, 3)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_bounded_cache_evicts_old_previews(self):
        import tachie_motion.web.preset_preview as preview_module

        with patch.object(preview_module, "thumbnail", return_value="data:image/png;base64,fake") as render:
            for number in range(7):
                states = [dict(item, visible=bool(number & (1 << i)))
                          for i, item in enumerate(self.states)]
                self.preview(states)
            self.assertEqual(render.call_count, 7)
            self.assertEqual(_cached_render.cache_info().currsize, 6)
            first = [dict(item, visible=False) for item in self.states]
            self.preview(first)
            self.assertEqual(render.call_count, 8)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_simultaneous_same_state_requests_render_once(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        from time import sleep
        import tachie_motion.web.preset_preview as preview_module

        start = Barrier(2)
        real_thumbnail = preview_module.thumbnail

        def delayed_thumbnail(psd):
            sleep(0.02)
            return real_thumbnail(psd)

        def request():
            start.wait(timeout=5)
            return self.preview()

        with patch.object(preview_module, "thumbnail", side_effect=delayed_thumbnail) as render:
            with ThreadPoolExecutor(max_workers=2) as pool:
                a = pool.submit(request)
                b = pool.submit(request)
                self.assertEqual(a.result(timeout=10), b.result(timeout=10))
            self.assertEqual(render.call_count, 1)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_failed_preview_is_never_cached(self):
        import tachie_motion.web.preset_preview as preview_module

        real_thumbnail = preview_module.thumbnail
        attempts = 0

        def fail_once(psd):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("render fails")
            return real_thumbnail(psd)

        with patch.object(preview_module, "thumbnail", side_effect=fail_once) as render:
            with self.assertRaisesRegex(RuntimeError, "render fails"):
                self.preview()
            self.preview()
            self.assertEqual(render.call_count, 2)
        self.assertEqual(_cached_render.cache_info().currsize, 1)
        self.assertEqual(self.source.read_bytes(), self.original)


if __name__ == "__main__":
    unittest.main()
