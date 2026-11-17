"""Policy-neutral synthetic timing tests for aiueo Slice 3 (Issue #27)."""

import unittest

from tachie_motion.audio.aiueo_frames import (
    FramePolicy, phonemes_by_frame, schedule_aiueo, shapes_by_frame,
)
from tachie_motion.audio.lab import LabInterval, TICKS_PER_SECOND, parse_lab


class AiueoFrameTests(unittest.TestCase):
    def test_anchor_choices_are_exact_at_fractional_frame_boundaries(self):
        intervals = parse_lab(
            "0 2500000 a\n2500000 5000000 i\n5000000 12500000 u\n",
            samples=5, sample_rate=4,
        )
        # 5 PCM samples at 4 Hz is 1.25 s, and 3 fps needs 4 frames.
        start = phonemes_by_frame(
            intervals, samples=5, sample_rate=4, fps=3, anchor="start",
        )
        middle = phonemes_by_frame(
            intervals, samples=5, sample_rate=4, fps=3, anchor="middle",
        )
        end = phonemes_by_frame(
            intervals, samples=5, sample_rate=4, fps=3, anchor="end",
        )
        self.assertEqual(start, ("a", "i", "u", "u"))
        self.assertEqual(middle, ("a", "u", "u", "u"))
        self.assertEqual(end, ("i", "u", "u", "u"))
        self.assertEqual(start, phonemes_by_frame(
            intervals, samples=5, sample_rate=4, fps=3, anchor="start",
        ))

    def test_consonant_rules_are_explicit_and_different(self):
        intervals = parse_lab(
            "0 2000000 sil\n2000000 4000000 k\n"
            "4000000 6000000 a\n6000000 8000000 t\n"
            "8000000 10000000 i\n",
            samples=10, sample_rate=10,
        )
        def schedule(consonants: str):
            return schedule_aiueo(
                intervals, samples=10, sample_rate=10, fps=10,
                policy=FramePolicy("middle", consonants, "rest"),
            )
        self.assertEqual(schedule("rest"),
            ("n", "n", "n", "n", "a", "a", "n", "n", "i", "i"))
        self.assertEqual(schedule("hold_previous"),
            ("n", "n", "n", "n", "a", "a", "a", "a", "i", "i"))
        self.assertEqual(schedule("anticipate_next"),
            ("n", "n", "a", "a", "a", "a", "i", "i", "i", "i"))

    def test_uppercase_vowel_policy_and_rest_reset(self):
        phones = ("a", "k", "A", "t", "N", "t", "I", "silE", "e", None, "k")
        rest = FramePolicy("start", "hold_previous", "rest")
        voiced = FramePolicy("start", "hold_previous", "vowel")
        self.assertEqual(shapes_by_frame(phones, policy=rest),
            ("a", "a", "n", "n", "n", "n", "n", "n", "e", "n", "n"))
        self.assertEqual(shapes_by_frame(phones, policy=voiced),
            ("a", "a", "a", "a", "n", "n", "i", "n", "e", "n", "n"))
        self.assertEqual(shapes_by_frame(("a", "k", "i", "pau", "t"), policy=FramePolicy(
            "middle", "anticipate_next", "vowel",
        )), ("a", "i", "i", "n", "n"))

    def test_lab_gaps_and_padded_video_tail_are_not_inferred(self):
        intervals = parse_lab(
            "0 2500000 a\n5000000 10000000 i\n",
            samples=5, sample_rate=4,
        )
        result = phonemes_by_frame(
            intervals, samples=5, sample_rate=4, fps=4, anchor="start",
        )
        self.assertEqual(result, ("a", None, "i", "i", None))
        self.assertEqual(schedule_aiueo(
            intervals, samples=5, sample_rate=4, fps=4,
            policy=FramePolicy("start", "hold_previous", "rest"),
        ), ("a", "n", "i", "i", "n"))
        self.assertEqual(TICKS_PER_SECOND, 10_000_000)

    def test_unknown_or_overlapping_data_and_implicit_policy_rejected(self):
        valid = (LabInterval(0, 5_000_000, "a"),)
        kwargs = {"samples": 10, "sample_rate": 10, "fps": 10, "anchor": "middle"}
        with self.assertRaisesRegex(ValueError, "LAB"):
            phonemes_by_frame((), **kwargs)
        with self.assertRaisesRegex(ValueError, "Unvalidated"):
            phonemes_by_frame((
                LabInterval(0, 5_000_000, "a"),
                LabInterval(4_000_000, 8_000_000, "i"),
            ), **kwargs)
        with self.assertRaisesRegex(ValueError, "Unvalidated"):
            phonemes_by_frame((LabInterval(0, 1, "mystery"),), **kwargs)
        with self.assertRaisesRegex(ValueError, "Unvalidated"):
            phonemes_by_frame((LabInterval(0, 10_000_001, "a"),), **kwargs)
        with self.assertRaisesRegex(ValueError, "positive"):
            phonemes_by_frame(valid, samples=True, sample_rate=10, fps=10, anchor="middle")
        with self.assertRaisesRegex(ValueError, "Explicit"):
            schedule_aiueo(valid, samples=10, sample_rate=10, fps=10, policy=None)
        with self.assertRaisesRegex(ValueError, "policy"):
            shapes_by_frame(("a",), policy=None)
        with self.assertRaisesRegex(ValueError, "phoneme"):
            shapes_by_frame(("unknown",), policy=FramePolicy("middle", "rest", "rest"))
        with self.assertRaisesRegex(ValueError, "consonant"):
            FramePolicy("middle", "invented", "rest")


if __name__ == "__main__":
    unittest.main()
