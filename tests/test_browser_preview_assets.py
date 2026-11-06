"""Synthetic source/fallback coverage for browser-only fast PSD preview (#55)."""

from base64 import b64decode
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from psd_tools import PSDImage
from psd_tools.constants import BlendMode

from tachie_motion.web import browser_preview_assets as fast
from tachie_motion.web.preview_frame import file_identity
from tachie_motion.web.preset_preview import preview_base_preset
from tachie_motion.psd.tree import walk_layers
from tachie_motion.web.service import load_psd


class BrowserPreviewAssetsTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.psd_file = Path(folder.name) / "あんこ た\u3099んもん.psd"
        psd = PSDImage.new(mode="RGB", size=(48, 48), depth=8)
        face = psd.create_group(name="face")
        face.create_pixel_layer(Image.new("RGB", (12, 14), (255, 0, 0)),
                                name="same", left=8, top=7)
        face.create_pixel_layer(Image.new("RGB", (12, 14), (0, 0, 255)),
                                name="same", left=11, top=13)
        psd.create_pixel_layer(Image.new("RGB", (42, 42), (40, 90, 60)),
                               name="body", left=3, top=3)
        psd.save(self.psd_file)
        self.original = self.psd_file.read_bytes()
        ident = file_identity(self.psd_file)
        self.token = f"{ident[3]}:{ident[4]}"

    def test_supported_assets_are_bounded_and_read_only(self):
        result = fast.layer_preview_assets(str(self.psd_file), self.token)
        self.assertTrue(result["supported"])
        self.assertEqual((result["width"], result["height"]), (48, 48))
        self.assertEqual((result["source_width"], result["source_height"]), (48, 48))
        self.assertEqual(result["source_identity"],
                         fast._identity_token(file_identity(self.psd_file)))
        self.assertEqual([row["path"] for row in result["layers"]],
                         ["0", "0/0", "0/1", "1"])
        self.assertEqual(len(set(row["path"] for row in result["layers"])), 4)
        self.assertEqual(result["layers"][0]["kind"], "group")
        self.assertIsNone(result["layers"][0]["png"])
        for row in result["layers"][1:]:
            with Image.open(BytesIO(b64decode(row["png"].split(",", 1)[1]))) as im:
                self.assertEqual(im.mode, "RGBA")
                self.assertEqual(im.size, tuple(row["rect"][2:]))
        self.assertEqual(self.psd_file.read_bytes(), self.original)

    def test_unhandled_blend_falls_back_to_full_python_preview(self):
        psd = PSDImage.open(self.psd_file)
        psd[0][0].blend_mode = BlendMode.MULTIPLY
        psd.save(self.psd_file)
        token = file_identity(self.psd_file)
        token = f"{token[3]}:{token[4]}"
        self.assertFalse(fast.layer_preview_assets(str(self.psd_file), token)["supported"])
        full = load_psd(str(self.psd_file))
        states = [{"path": "/".join(map(str, item.index_path)),
                   "visible": item.visible} for item in walk_layers(full)]
        rendered = preview_base_preset(str(self.psd_file), token, states)
        self.assertTrue(rendered["preview"].startswith("data:image/png;base64,"))
        self.assertEqual(self.psd_file.read_bytes(), self.psd_file.read_bytes())

    def test_stale_fingerprint_is_error_not_previous_assets(self):
        with self.assertRaisesRegex(ValueError, "changed"):
            fast.layer_preview_assets(str(self.psd_file), "outdated")
        self.assertEqual(self.psd_file.read_bytes(), self.original)

    def test_source_changes_during_extraction_aborts(self):
        actual = file_identity(self.psd_file)
        altered = (*actual[:3], actual[3] + 1, actual[4])
        with patch.object(fast, "file_identity",
                          side_effect=[actual, actual, altered]):
            with self.assertRaisesRegex(ValueError, "changed during layer"):
                fast.layer_preview_assets(str(self.psd_file), self.token)

    def test_half_pixel_coordinates_use_javascript_rounding(self):
        self.assertEqual(
            fast._scaled_box((5, 0, 15, 10), (1000, 1000), (900, 900)),
            (5, 0, 14, 9),
        )

    def test_legacy_preview_rejects_replaced_psd_with_same_size_and_mtime(self):
        import os
        old = file_identity(self.psd_file)
        source_identity = fast._identity_token(old)
        full = load_psd(str(self.psd_file))
        states = [{"path": "/".join(map(str, item.index_path)),
                   "visible": item.visible} for item in walk_layers(full)]
        self.assertTrue(preview_base_preset(
            str(self.psd_file), self.token, states,
            source_identity=source_identity,
        )["preview"].startswith("data:image/png;base64,"))

        replacement = self.psd_file.with_suffix(".replacement")
        replacement.write_bytes(self.original)
        os.utime(replacement, ns=(old[4], old[4]))
        os.replace(replacement, self.psd_file)
        self.assertEqual(self.psd_file.stat().st_size, old[3])
        self.assertEqual(self.psd_file.stat().st_mtime_ns, old[4])
        with self.assertRaisesRegex(ValueError, "identity has changed"):
            preview_base_preset(
                str(self.psd_file), self.token, states,
                source_identity=source_identity,
            )

    def test_huge_layer_bounds_reject_before_pixel_decode(self):
        with patch.object(fast, "MAX_SOURCE_TOTAL_PIXELS", 1):
            with patch.object(fast, "resolve_layer",
                              side_effect=AssertionError("decoded huge layer")):
                self.assertFalse(fast.layer_preview_assets(
                    str(self.psd_file), self.token)["supported"])
        self.assertEqual(self.psd_file.read_bytes(), self.original)

    def test_source_identity_change_after_canvas_preparation(self):
        initial = fast.layer_preview_assets(str(self.psd_file), self.token)
        self.assertTrue(initial["supported"])
        self.assertEqual(initial["source_identity"],
                         fast._identity_token(file_identity(self.psd_file)))
        self.assertTrue(fast.preview_source_status(
            str(self.psd_file), self.token, initial["source_identity"])["valid"])

        # Model an external editor saving the same PSD path and layer tree.
        psd = PSDImage.open(self.psd_file)
        psd[0][0].visible = not psd[0][0].visible
        psd.save(self.psd_file)
        self.assertFalse(fast.preview_source_status(
            str(self.psd_file), self.token, initial["source_identity"])["valid"])
        self.assertNotEqual(self.psd_file.read_bytes(), self.original)

    def test_same_size_and_mtime_external_replacement_is_invalid(self):
        import os
        old = file_identity(self.psd_file)
        ident = fast._identity_token(old)
        replacement = self.psd_file.with_suffix(".new")
        replacement.write_bytes(self.original)
        os.utime(replacement, ns=(old[4], old[4]))
        os.replace(replacement, self.psd_file)
        self.assertEqual(self.psd_file.stat().st_size, old[3])
        self.assertEqual(self.psd_file.stat().st_mtime_ns, old[4])
        self.assertFalse(fast.preview_source_status(
            str(self.psd_file), self.token, ident)["valid"])

    def test_missing_psd_is_no_longer_a_valid_canvas_source(self):
        old = fast._identity_token(file_identity(self.psd_file))
        self.psd_file.unlink()
        self.assertFalse(fast.preview_source_status(
            str(self.psd_file), self.token, old)["valid"])

    def test_source_status_never_decodes_or_composites(self):
        with (patch.object(fast, "load_psd", side_effect=AssertionError("PSD opened")),
              patch.object(fast, "resolve_layer", side_effect=AssertionError("bitmap decoded"))):
            identity = fast._identity_token(file_identity(self.psd_file))
            self.assertTrue(fast.preview_source_status(
                str(self.psd_file), self.token, identity)["valid"])

    def test_transfer_and_decoded_budgets_request_python_fallback(self):
        for limit in ("MAX_DECODED_BYTES", "MAX_PNG_BYTES"):
            with self.subTest(limit=limit):
                with patch.object(fast, limit, 1):
                    self.assertFalse(fast.layer_preview_assets(
                        str(self.psd_file), self.token)["supported"])
        self.assertEqual(self.psd_file.read_bytes(), self.original)


if __name__ == "__main__":
    unittest.main()
