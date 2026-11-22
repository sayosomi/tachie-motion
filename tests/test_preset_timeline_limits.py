"""Fail-closed pose limits without allocating real PSD/RGBA memory."""

from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tachie_motion.web.preset_timeline_render import render_timeline_states


def state(number: int) -> dict:
    return {
        "sample": number, "preset_id": f"preset-{number}",
        "layers": [{"path": str(number), "visible": True}],
        "mouth": None, "aiueo_mouth": None, "mode": "none",
        "blink_enabled": False, "eyes": None, "blink_timing": None,
    }


class PresetTimelineSafetyLimitTests(unittest.TestCase):
    def render(self, configurations: int, *, width: int = 16, height: int = 16):
        schedule = SimpleNamespace(
            sample_count=70, sample_rate=30,
            frames=[SimpleNamespace(mouth="closed") for _ in range(70)],
        )
        psd = SimpleNamespace(width=width, height=height)
        with (
            TemporaryDirectory() as directory,
            patch("tachie_motion.web.preset_timeline_render._validated_base",
                  return_value={"0": True}),
            patch("tachie_motion.web.preset_timeline_render.walk_layers",
                  return_value=[]),
            patch("tachie_motion.web.preset_timeline_render.validate_psdtool_state"),
            patch("tachie_motion.web.preset_timeline_render.resolve_layer",
                  return_value=SimpleNamespace(visible=True)),
            patch("tachie_motion.web.preset_timeline_render.write_fixed_crop_png") as write,
        ):
            first = state(0)
            changes = tuple(state(i) for i in range(1, configurations))
            try:
                result = render_timeline_states(
                    psd, first, changes, schedule=schedule, fps=30,
                    mouth_groups=None, eye_groups=None, lab_indices=None,
                    directory=Path(directory), check_cancel=lambda: None,
                    validate_open_mouth=lambda *_: None,
                )
                return result, write.call_count
            except ValueError:
                self.assertLessEqual(write.call_count, 64)
                raise

    def test_64_distinct_configurations_allowed_and_65_rejected(self):
        (pngs, indices), written = self.render(64)
        self.assertEqual(len(pngs), 64)
        self.assertEqual(written, 64)
        self.assertEqual(len(indices), 70)
        with self.assertRaisesRegex(ValueError, "Too many distinct"):
            self.render(65)

    def test_512_mib_rgba_boundary_allowed_and_next_pose_rejected(self):
        # Each state is one mock pose; no image of this size is allocated.
        width, height = 16384, 8192  # width * height * 4 == 512 MiB
        (_, indices), written = self.render(1, width=width, height=height)
        self.assertEqual(len(indices), 70)
        self.assertEqual(written, 1)
        with self.assertRaisesRegex(ValueError, "512 MiB"):
            self.render(2, width=width, height=height)


if __name__ == "__main__":
    unittest.main()
