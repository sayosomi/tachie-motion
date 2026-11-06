"""Synthetic, media-free tests for the first Phase 1 WAV mouth scheduler."""

import hashlib
import json
import struct
from pathlib import Path
import tempfile
import unittest
import wave

from tachie_motion.audio.cli import main
from tachie_motion.audio.volume import (
    analyze_wav, gate_levels, write_schedule_json,
)


def make_wav(
    path: Path, *, rate: int = 480, width: int = 2,
    channels: int = 1, frames: list[tuple[int, ...]],
) -> None:
    payload = bytearray()
    for frame in frames:
        if len(frame) != channels:
            raise ValueError("test fixture's channel count is wrong")
        for value in frame:
            if width == 1:
                payload.append(value + 128)
            else:
                payload.extend(value.to_bytes(width, "little", signed=True))
    with wave.open(str(path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(width)
        out.setframerate(rate)
        out.writeframes(bytes(payload))


class VolumeScheduleTests(unittest.TestCase):
    def test_pure_gate_threshold_boundaries_and_validation(self):
        result = gate_levels(
            [0.0, 0.2, 0.1, 0.099, 0.25, 0.1, 0.0],
            open_threshold=0.2, close_threshold=0.1,
        )
        self.assertEqual(
            result, ("closed", "open", "open", "closed", "open", "open", "closed")
        )
        for levels in ([float("nan")], [-0.1], [1.1], [float("inf")]):
            with self.subTest(levels=levels), self.assertRaises(ValueError):
                gate_levels(levels)
        for opened, closed in ((0, 0), (0.1, 0.2), (1.1, 0.1), (0.1, -0.1)):
            with self.subTest(thresholds=(opened, closed)):
                with self.assertRaises(ValueError):
                    gate_levels([0], open_threshold=opened, close_threshold=closed)

    def test_frame_windows_rms_hysteresis_and_source_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / "話す.wav"
            amplitude = [0, 16384, 8192, 0]
            make_wav(wav, frames=[(value,) for value in amplitude for _ in range(20)])
            original = hashlib.sha256(wav.read_bytes()).hexdigest()
            result = analyze_wav(
                wav, fps=24, open_threshold=0.4, close_threshold=0.2
            )
            self.assertEqual(result.sample_count, 80)
            self.assertEqual(result.sample_rate, 480)
            self.assertEqual(result.sample_width_bits, 16)
            self.assertEqual(
                [f.mouth for f in result.frames],
                ["closed", "open", "open", "closed"],
            )
            self.assertEqual(
                [(f.start_sample, f.end_sample) for f in result.frames],
                [(0, 20), (20, 40), (40, 60), (60, 80)],
            )
            self.assertAlmostEqual(result.frames[1].rms, 0.5)
            self.assertAlmostEqual(result.frames[2].rms, 0.25)
            self.assertEqual(hashlib.sha256(wav.read_bytes()).hexdigest(), original)

    def test_ceil_frame_count_and_noninteger_sample_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / "partial.wav"
            make_wav(wav, rate=1000, frames=[(0,)] * 101)
            result = analyze_wav(wav, fps=30)
            self.assertEqual(len(result.frames), 4)
            self.assertEqual(
                [(f.start_sample, f.end_sample) for f in result.frames],
                [(0, 34), (34, 67), (67, 100), (100, 101)],
            )
            self.assertEqual(result.frames[-1].mouth, "closed")
            self.assertEqual(sum(f.end_sample - f.start_sample for f in result.frames), 101)

    def test_24_30_60_fps_duration_rounding_and_determinism(self):
        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / "long.wav"
            make_wav(wav, rate=1000, frames=[(4000,)] * 1001)
            for fps in (24, 30, 60):
                with self.subTest(fps=fps):
                    a = analyze_wav(wav, fps=fps)
                    b = analyze_wav(wav, fps=fps)
                    self.assertEqual(len(a.frames), fps + 1)
                    self.assertEqual(a, b)
                    self.assertEqual(a.frames[0].start_sample, 0)
                    self.assertEqual(a.frames[-1].end_sample, 1001)

    def test_stereo_antiphase_does_not_cancel(self):
        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / "stereo.wav"
            make_wav(wav, channels=2, frames=[(30000, -30000)] * 20)
            result = analyze_wav(wav, fps=24, open_threshold=0.9)
            self.assertEqual(result.channels, 2)
            self.assertGreater(result.frames[0].rms, 0.91)
            self.assertEqual(result.frames[0].mouth, "open")

    def test_all_supported_integer_pcm_widths(self):
        with tempfile.TemporaryDirectory() as directory:
            for width in (1, 2, 3, 4):
                with self.subTest(width=width):
                    path = Path(directory) / f"pcm{width}.wav"
                    value = (1 << (width * 8 - 2))
                    make_wav(
                        path, rate=1200, width=width,
                        frames=[(value,)] * 40,
                    )
                    result = analyze_wav(path, fps=30)
                    self.assertEqual(result.sample_width_bits, width * 8)
                    self.assertAlmostEqual(result.frames[0].rms, 0.5, places=6)

    def test_malformed_truncated_and_unsupported_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            missing = folder / "missing.wav"
            with self.assertRaisesRegex(ValueError, "does not exist"):
                analyze_wav(missing)
            invalid = folder / "invalid.wav"
            invalid.write_bytes(b"not RIFF")
            with self.assertRaises(ValueError):
                analyze_wav(invalid)
            truncated = folder / "truncated.wav"
            make_wav(truncated, frames=[(1000,)] * 40)
            truncated.write_bytes(truncated.read_bytes()[:-2])
            with self.assertRaisesRegex(ValueError, "Truncated"):
                analyze_wav(truncated)
            unsupported = folder / "unsupported.wav"
            make_wav(unsupported, width=4, frames=[(123,)] * 40)
            # Python's wave writer itself refuses width=5; mutate the
            # original synthetic header to advertise 40-bit PCM instead.
            header = bytearray(unsupported.read_bytes())
            header[32:34] = (5).to_bytes(2, "little")  # block align
            header[34:36] = (40).to_bytes(2, "little")  # bits per sample
            unsupported.write_bytes(header)
            with self.assertRaisesRegex(ValueError, "8/16/24/32"):
                analyze_wav(unsupported)
            empty = folder / "empty.wav"
            make_wav(empty, frames=[])
            with self.assertRaisesRegex(ValueError, "positive"):
                analyze_wav(empty)
            with self.assertRaisesRegex(ValueError, "fps"):
                analyze_wav(truncated, fps=25)

    def test_rejects_declared_partial_stereo_pcm_frame_without_json(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            wav = folder / "incomplete-stereo.wav"
            make_wav(wav, channels=2, frames=[(1000, -1000)])
            broken = bytearray(wav.read_bytes())
            broken.append(0x7F)  # five bytes, but stereo/16-bit needs four per frame
            struct.pack_into("<I", broken, 4, len(broken) - 8)
            struct.pack_into("<I", broken, 40, 5)  # data declared size also five
            wav.write_bytes(broken)
            with wave.open(str(wav), "rb") as reader:
                self.assertEqual(reader.getnframes(), 1)  # wave silently floors
            with self.assertRaisesRegex(ValueError, "Incomplete PCM sample frame"):
                analyze_wav(wav)
            output = folder / "should-not-exist.json"
            self.assertEqual(main(["--wav", str(wav), "--output", str(output)]), 2)
            self.assertFalse(output.exists())
            self.assertEqual(wav.read_bytes(), broken)

    def test_rejects_inconsistent_fmt_align_and_byte_rate(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            valid = folder / "valid-stereo.wav"
            make_wav(valid, channels=2, frames=[(1000, -1000)] * 10)
            original = valid.read_bytes()
            for offset, fmt, value in (
                (32, "<H", 2),     # block_align should be four bytes
                (28, "<I", 480),   # byte_rate should be 480 * 4
            ):
                with self.subTest(offset=offset):
                    broken = bytearray(original)
                    struct.pack_into(fmt, broken, offset, value)
                    path = folder / f"bad-fmt-{offset}.wav"
                    path.write_bytes(broken)
                    # Both inconsistencies can be accepted by wave.
                    with wave.open(str(path), "rb") as reader:
                        self.assertEqual(reader.getnframes(), 10)
                    with self.assertRaisesRegex(ValueError, "fmt block_align or byte_rate"):
                        analyze_wav(path)
                    self.assertEqual(path.read_bytes(), broken)

    def test_accepts_odd_size_pcm_and_padded_unknown_riff_chunk(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            wav = folder / "odd-8-bit.wav"
            make_wav(wav, width=1, frames=[(0,)] * 5)
            # Python's wave writer omits a final pad for an odd data chunk.
            self.assertEqual(len(analyze_wav(wav).frames), 1)
            original = wav.read_bytes()
            extra = b"JUNK" + struct.pack("<I", 3) + b"abc" + bytes([0])
            modified = bytearray(original[:36] + extra + original[36:])
            struct.pack_into("<I", modified, 4, len(modified) - 8)
            wav.write_bytes(modified)
            self.assertEqual(analyze_wav(wav).sample_count, 5)

    def test_json_cli_is_versioned_deterministic_and_no_clobber(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            wav = folder / "発話音声.wav"
            make_wav(wav, frames=[(12000,)] * 30)
            original = wav.read_bytes()
            first = folder / "口の動き.json"
            second = folder / "repeat.json"
            self.assertEqual(main(["--wav", str(wav), "--output", str(first)]), 0)
            self.assertEqual(main(["--wav", str(wav), "--output", str(second)]), 0)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            obj = json.loads(first.read_text(encoding="utf-8"))
            self.assertEqual(obj["schema_version"], 1)
            self.assertEqual(obj["frame_count"], len(obj["frames"]))
            self.assertEqual(obj["frames"][0]["mouth"], "open")
            self.assertNotIn(str(wav), first.read_text(encoding="utf-8"))
            self.assertEqual(main(["--wav", str(wav), "--output", str(first)]), 2)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(wav.read_bytes(), original)
            with self.assertRaisesRegex(ValueError, ".json"):
                write_schedule_json(analyze_wav(wav), folder / "bad.txt")


if __name__ == "__main__":
    unittest.main()
