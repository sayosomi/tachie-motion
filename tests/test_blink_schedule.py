"""Synthetic tests for the pure closed-eye frame scheduler (Issue #34)."""

import unittest
from unittest.mock import patch

from tachie_motion.animation.blink import (
    schedule_blink_frames, schedule_random_blink_frames,
    compose_mouth_eye_indices,
)


class BlinkScheduleTests(unittest.TestCase):
    def schedule(self, **changes):
        options = dict(
            frame_count=20, interval_frames=5, closed_frames=2,
            jitter_frames=0, phase_frames=1, seed=19,
        )
        options.update(changes)
        return schedule_blink_frames(**options)

    def test_exact_integer_frame_intervals_and_end_clipping(self):
        actual = self.schedule(frame_count=13)
        self.assertEqual(
            [i for i, closed in enumerate(actual) if closed],
            [1, 2, 6, 7, 11, 12],
        )
        self.assertEqual(len(actual), 13)

    def test_empty_and_short_utterance_have_no_unexpected_blink(self):
        self.assertEqual(self.schedule(frame_count=0), ())
        self.assertEqual(self.schedule(frame_count=1), (False,))
        self.assertEqual(self.schedule(frame_count=2), (False, True))

    def test_frame_rate_agnostic_counts_at_24_30_and_60_fps(self):
        # The caller supplies FPS-derived integer intervals; the scheduler
        # neither rounds time nor changes the returned frame count.
        for fps in (24, 30, 60):
            with self.subTest(fps=fps):
                closed = self.schedule(
                    frame_count=3 * fps + 1, interval_frames=fps,
                    closed_frames=2, phase_frames=fps // 2,
                )
                self.assertEqual(len(closed), 3 * fps + 1)
                self.assertEqual(
                    [i for i, state in enumerate(closed) if state],
                    [fps // 2 + n * fps + delta
                     for n in range(3) for delta in (0, 1)],
                )

    def test_jitter_is_deterministic_and_has_open_gaps(self):
        arguments = dict(
            frame_count=600, interval_frames=15,
            closed_frames=3, jitter_frames=8, phase_frames=4,
        )
        first = self.schedule(**arguments, seed=123456789)
        self.assertEqual(first, self.schedule(**arguments, seed=123456789))
        self.assertNotEqual(first, self.schedule(**arguments, seed=987654321))
        self.assertEqual(len(first), arguments["frame_count"])

        starts = [i for i, value in enumerate(first)
                  if value and (i == 0 or not first[i - 1])]
        self.assertGreater(len(starts), 2)
        self.assertTrue(all(7 <= b - a <= 23 for a, b in zip(starts, starts[1:])))
        self.assertTrue(all(not first[i] for i in range(0, 4)))

    def test_explicit_phase_can_place_first_blink_outside_clip(self):
        self.assertFalse(any(self.schedule(frame_count=10, phase_frames=20)))
        self.assertEqual(
            self.schedule(frame_count=8, phase_frames=7),
            (False,) * 7 + (True,),
        )

    def test_each_export_draws_fresh_seed_and_first_blink_offset(self):
        params = dict(
            frame_count=100, interval_frames=10,
            closed_frames=2, jitter_frames=2,
            phase_frames=4, seed=0,
        )
        with (patch("tachie_motion.animation.blink.secrets.randbits",
                    side_effect=[101, 202]) as new_seed,
              patch("tachie_motion.animation.blink.secrets.randbelow",
                    side_effect=[0, 4]) as first_offset):
            early = schedule_random_blink_frames(**params)
            late = schedule_random_blink_frames(**params)
        self.assertEqual(next(i for i, value in enumerate(early) if value), 2)
        self.assertEqual(next(i for i, value in enumerate(late) if value), 6)
        self.assertNotEqual(early, late)
        self.assertEqual(new_seed.call_count, 2)
        self.assertEqual(first_offset.call_count, 2)

    def test_zero_jitter_disables_variation_and_invalid_settings_still_fail(self):
        params = dict(
            frame_count=90, interval_frames=30,
            closed_frames=3, jitter_frames=0,
            phase_frames=7, seed=0,
        )
        with (patch("tachie_motion.animation.blink.secrets.randbits",
                    return_value=999) as new_seed,
              patch("tachie_motion.animation.blink.secrets.randbelow") as offset):
            actual = schedule_random_blink_frames(**params)
        self.assertEqual(actual, schedule_blink_frames(**params))
        new_seed.assert_called_once_with(64)
        offset.assert_not_called()
        with patch("tachie_motion.animation.blink.secrets.randbits") as new_seed:
            with self.assertRaises(ValueError):
                schedule_random_blink_frames(**{**params, "closed_frames": 30})
            new_seed.assert_not_called()

    def test_combined_indices_cover_none_open_and_aiueo(self):
        self.assertEqual(
            compose_mouth_eye_indices((0, 0), (False, True),
                                     mouth_pose_count=1), (0, 1),
        )
        self.assertEqual(
            compose_mouth_eye_indices((0, 1, 1), (True, False, True),
                                     mouth_pose_count=2), (1, 2, 3),
        )
        self.assertEqual(
            compose_mouth_eye_indices((0, 1, 5, 5),
                                     (False, True, False, True),
                                     mouth_pose_count=6),
            (0, 3, 10, 11),
        )

    def test_combined_indices_reject_wrong_length_and_bad_types(self):
        for mouths, eyes, count in (
            ((0,), (), 1), ((0,), (False,), 0),
            ((1,), (True,), 1), ((0.0,), (True,), 1),
            ((0,), (1,), 1), ((True,), (True,), 1),
        ):
            with self.subTest(mouths=mouths, eyes=eyes, count=count):
                with self.assertRaises(ValueError):
                    compose_mouth_eye_indices(mouths, eyes,
                                             mouth_pose_count=count)

    def test_rejects_invalid_settings_instead_of_hanging_or_guessing(self):
        invalid = (
            {"frame_count": -1}, {"frame_count": True},
            {"interval_frames": 0}, {"interval_frames": True},
            {"closed_frames": 0}, {"closed_frames": 3, "interval_frames": 3},
            {"jitter_frames": -1}, {"jitter_frames": 5},
            {"jitter_frames": 3, "interval_frames": 5, "closed_frames": 2},
            {"phase_frames": -1}, {"seed": True}, {"seed": 1.5},
        )
        for case in invalid:
            with self.subTest(case=case), self.assertRaises(ValueError):
                self.schedule(**case)


if __name__ == "__main__":
    unittest.main()
