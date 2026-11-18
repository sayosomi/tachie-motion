"""Synthetic tests for the pure closed-eye frame scheduler (Issue #34)."""

import unittest

from tachie_motion.animation.blink import schedule_blink_frames


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
