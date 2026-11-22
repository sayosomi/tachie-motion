"""Sample-accurate timeline rules; synthetic data only."""

import unittest

from tachie_motion.web.preset_timeline import (
    MAX_PRESET_CHANGE_POINTS, segments_by_frame, validate_timeline_changes,
)


def point(sample, preset_id="smile"):
    return {
        "sample": sample, "preset_id": preset_id,
        "layers": [{"path": "0", "visible": True}],
        "mouth": None, "aiueo_mouth": None, "mode": "none",
        "blink_enabled": False, "eyes": None, "blink_timing": None,
    }


class PresetTimelineTests(unittest.TestCase):
    def test_frame_center_switches_and_last_sample_clamps(self):
        changes = validate_timeline_changes([point(1600), point(48000, "sad")],
                                             samples=48001)
        frames = segments_by_frame(
            changes, samples=48001, sample_rate=48000, fps=30,
            frame_count=31,
        )
        self.assertEqual(frames[:3], (0, 1, 1))
        self.assertEqual(frames[-1], 2)
        self.assertEqual(len(frames), 31)

    def test_at_24_and_60_fps(self):
        for fps, boundary in ((24, 1000), (60, 400)):
            with self.subTest(fps=fps):
                changes = validate_timeline_changes([point(boundary)], samples=48000)
                frames = segments_by_frame(
                    changes, samples=48000, sample_rate=48000,
                    fps=fps, frame_count=fps,
                )
                self.assertEqual(frames[0], 1)
                self.assertEqual(frames[-1], 1)

    def test_malformed_or_unordered_change_points_rejected(self):
        bad = (
            [point(0)], [point(48000)], [point(-1)], [point(1.5)],
            [point(True)], [point(800), point(800)],
            [point(900), point(800)], [dict(point(800), extra=1)],
            [dict(point(800), preset_id="")],
            [dict(point(800), mode="bad")],
            [dict(point(800), blink_enabled=1)],
            [dict(point(800), layers={})],
            [dict(point(800), blink_timing=[])],
            {}, list(range(3)), [point(i + 1) for i in range(MAX_PRESET_CHANGE_POINTS + 1)],
        )
        for case in bad:
            with self.subTest(value=str(case)[:50]):
                with self.assertRaises(ValueError):
                    validate_timeline_changes(case, samples=48000)

    def test_invalid_video_frame_count_fails(self):
        changes = validate_timeline_changes([point(1)], samples=48001)
        with self.assertRaisesRegex(ValueError, "frame count"):
            segments_by_frame(changes, samples=48001, sample_rate=48000,
                              fps=30, frame_count=30)

    def test_repeated_preset_changes_keep_independent_boundaries(self):
        a = validate_timeline_changes([point(20), point(60, "normal")], samples=100)
        b = validate_timeline_changes([point(40, "surprised")], samples=100)
        self.assertEqual([x["sample"] for x in a], [20, 60])
        self.assertEqual([x["sample"] for x in b], [40])
        self.assertEqual(a[0]["preset_id"], "smile")


if __name__ == "__main__":
    unittest.main()
