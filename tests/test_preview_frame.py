"""Conservative preview ROI fast-path integration and fallback tests."""

from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from psd_tools import PSDImage
from psd_tools.constants import BlendMode

import tachie_motion.web.preview_frame as frames
import tachie_motion.web.preset_preview as preset_module
from tachie_motion.psd.visibility import parse_index_path, resolve_layer
from tachie_motion.web.service import describe_psd, load_psd, thumbnail


class PreviewFrameTests(unittest.TestCase):
    def setUp(self):
        frames.clear_frame_cache()
        preset_module._cached_render.cache_clear()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "キャラ た\u3099んもん.psd"
        doc = PSDImage.new(mode="RGB", size=(64, 64), depth=8)
        group = doc.create_group(name="face")
        group.create_pixel_layer(
            Image.new("RGB", (13, 15), (220, 60, 40)),
            name="mouth", top=9, left=12,
        )
        group.create_pixel_layer(
            Image.new("RGB", (14, 16), (10, 220, 80)),
            name="eyes", top=10, left=11,
        )
        doc.create_pixel_layer(
            Image.new("RGB", (58, 56), (40, 70, 255)),
            name="body", top=4, left=3,
        )
        doc.save(self.source)
        self.original = self.source.read_bytes()
        self.info = describe_psd(str(self.source))
        self.states = [
            {"path": x["path"], "visible": x["visible"]}
            for x in self.info["layers"]
        ]
        self.leaves = [x["path"] for x in self.info["layers"] if x["kind"] == "pixel"]
        self.group = next(x["path"] for x in self.info["layers"] if x["kind"] == "group")

    def toggle(self, *paths):
        result = [dict(item) for item in self.states]
        for item in result:
            if item["path"] in paths:
                item["visible"] = not item["visible"]
        return result

    def request(self, states):
        return preset_module.preview_base_preset(
            str(self.source), self.info["fingerprint"], states,
        )["preview"]

    def expected(self, states):
        psd = load_psd(str(self.source))
        for item in states:
            resolve_layer(psd, parse_index_path(item["path"])).visible = item["visible"]
        return thumbnail(psd)

    def test_initial_load_primes_one_bounded_rgba_frame(self):
        loaded = load_psd(str(self.source))
        diagnostics = {
            "color_mode": repr(loaded.color_mode),
            "depth": loaded.depth,
            "layers": [
                {
                    "kind": layer.kind, "blend": repr(layer.blend_mode),
                    "opacity": layer.opacity, "fill": layer.fill_opacity,
                    "clip": layer.clipping, "mask": layer.has_mask(),
                    "vector_mask": layer.has_vector_mask(),
                    "effects": bool(layer.effects),
                }
                for layer in loaded.descendants()
            ],
        }
        self.assertTrue(frames.is_roi_safe(loaded), repr(diagnostics))
        self.assertIsNotNone(frames._last_frame)
        self.assertEqual(frames._last_frame.rgba.size, (64, 64))
        self.assertEqual(frames._last_frame.path, str(self.source.resolve()))
        self.assertEqual(self.info["preview"], self.expected(self.states))
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_roi_png_icc_creation_timestamp_does_not_affect_pixels(self):
        # Real PSDs regenerate ICC creation timestamps on independent renders.
        # Only that 12-byte field may differ; do not discard color metadata.
        from base64 import b64decode
        from io import BytesIO
        from PIL import ImageCms

        frame = frames._last_frame
        profile = ImageCms.ImageCmsProfile(
            ImageCms.createProfile("sRGB")
        ).tobytes()
        self.assertGreaterEqual(len(profile), 128)

        early = bytes.fromhex("07e8 0001 0002 0003 0004 0005")
        later = bytes.fromhex("07e9 0001 0002 0003 0004 0005")
        first_profile = profile[:24] + early + profile[36:]
        second_profile = profile[:24] + later + profile[36:]
        frame.rgba.info["icc_profile"] = first_profile

        states = self.toggle(self.leaves[0])
        with patch.object(frames, "composite_roi", wraps=frames.composite_roi) as roi:
            actual = self.request(states)
            self.assertEqual(roi.call_count, 1)
        self.assertEqual(frames._last_frame.rgba.info["icc_profile"], first_profile)

        reference = load_psd(str(self.source))
        for item in states:
            resolve_layer(
                reference, parse_index_path(item["path"]),
            ).visible = item["visible"]
        full_rgba = frames.composite_rgba(reference)
        self.assertEqual(frames._last_frame.rgba.tobytes(), full_rgba.tobytes())
        full_rgba.info["icc_profile"] = second_profile
        expected = frames.thumbnail_from_rgba(full_rgba)

        self.assertNotEqual(actual, expected)
        with (
            Image.open(BytesIO(b64decode(actual.split(",", 1)[1]))) as got,
            Image.open(BytesIO(b64decode(expected.split(",", 1)[1]))) as want,
        ):
            self.assertEqual(got.convert("RGBA").tobytes(),
                             want.convert("RGBA").tobytes())
            got_icc = got.info["icc_profile"]
            want_icc = want.info["icc_profile"]
            self.assertEqual(got_icc, first_profile)
            self.assertEqual(want_icc, second_profile)
            self.assertEqual(got_icc[:24] + got_icc[36:],
                             want_icc[:24] + want_icc[36:])
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_single_leaf_uses_roi_and_matches_exact_full_png(self):
        states = self.toggle(self.leaves[0])
        baseline = self.expected(states)
        with (patch.object(frames, "composite_roi", wraps=frames.composite_roi) as roi,
              patch.object(frames, "composite_rgba", wraps=frames.composite_rgba) as full):
            self.assertEqual(self.request(states), baseline)
            self.assertEqual(roi.call_count, 1, "Fast path must execute")
            self.assertEqual(full.call_count, 0, "No full rendering on ROI hit")
        # A new state from the previous changed state also needs full fidelity.
        newer = self.toggle(self.leaves[0], self.leaves[1])
        with patch.object(frames, "composite_roi", wraps=frames.composite_roi) as roi:
            self.assertEqual(self.request(newer), self.expected(newer))
            self.assertEqual(roi.call_count, 1)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_group_and_multiple_changes_use_full_fallback(self):
        for changed in ((self.group,), (self.leaves[0], self.leaves[1])):
            frames.clear_frame_cache()
            preset_module._cached_render.cache_clear()
            self.info = describe_psd(str(self.source))
            states = self.toggle(*changed)
            with (patch.object(frames, "composite_roi", wraps=frames.composite_roi) as roi,
                  patch.object(frames, "composite_rgba", wraps=frames.composite_rgba) as full):
                result = self.request(states)
                self.assertEqual(roi.call_count, 0)
                self.assertEqual(full.call_count, 1)
            self.assertEqual(result, self.expected(states))

    def test_roi_compositor_failure_recovers_by_full_render(self):
        states = self.toggle(self.leaves[0])
        expected = self.expected(states)
        with (patch.object(frames, "composite_roi", side_effect=RuntimeError("ROI fails")) as roi,
              patch.object(frames, "composite_rgba", wraps=frames.composite_rgba) as full):
            self.assertEqual(self.request(states), expected)
            self.assertEqual(roi.call_count, 1)
            self.assertEqual(full.call_count, 1)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_risky_blend_never_enables_roi(self):
        psd = load_psd(str(self.source))
        resolve_layer(psd, parse_index_path(self.leaves[0])).blend_mode = BlendMode.MULTIPLY
        self.assertFalse(frames.is_roi_safe(psd))
        self.assertTrue(frames.is_roi_safe(load_psd(str(self.source))))

    def test_bounded_rgba_rejects_oversized_cache_even_when_png_allowed(self):
        frames.clear_frame_cache()
        preset_module._cached_render.cache_clear()
        with patch.object(frames, "MAX_FRAME_BYTES", 1):
            self.info = describe_psd(str(self.source))
            self.assertIsNone(frames._last_frame)
            states = self.toggle(self.leaves[0])
            with patch.object(frames, "composite_roi") as roi:
                self.assertEqual(self.request(states), self.expected(states))
                roi.assert_not_called()
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_replaced_source_cannot_reuse_old_rgba_frame(self):
        old = frames._last_frame
        before = self.source.stat()
        replacement = Path(self.temp.name) / "replacement.psd"
        replacement.write_bytes(self.original)
        os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
        os.replace(replacement, self.source)
        states = self.toggle(self.leaves[0])
        with patch.object(frames, "composite_roi", wraps=frames.composite_roi) as roi:
            self.assertEqual(self.request(states), self.expected(states))
            roi.assert_not_called()
        self.assertIsNot(frames._last_frame, old)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_changed_source_during_render_never_publishes(self):
        original_frame = frames._last_frame
        expected_identity = frames.file_identity(self.source)
        changed_identity = tuple([
            expected_identity[0], expected_identity[1],
            expected_identity[2] + 1, *expected_identity[3:],
        ])
        states = self.toggle(self.leaves[0])
        # request's first identity read, load validation read, render final read
        with patch.object(
            preset_module, "_file_identity",
            side_effect=[expected_identity, expected_identity, expected_identity, changed_identity],
        ):
            with self.assertRaisesRegex(ValueError, "changed"):
                self.request(states)
        self.assertIs(frames._last_frame, original_frame)
        self.assertEqual(preset_module._cached_render.cache_info().currsize, 0)
        self.assertEqual(self.source.read_bytes(), self.original)


if __name__ == "__main__":
    unittest.main()
