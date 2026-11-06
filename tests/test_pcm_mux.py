"""Synthetic, sample-exact PCM-in-ProRes MOV integration tests (no user media)."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import wave

from tachie_motion.audio.volume import analyze_wav
from tachie_motion.render import pcm_mux
from tachie_motion.render.pcm_mux import mux_verified_pcm


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "Real FFmpeg and ffprobe required",
)
class PCMMuxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.video = self.root / "silent.mov"
        # Four alpha-bearing ProRes frames, slightly longer than the WAV.
        rgba = bytes([20, 40, 80, 128] * 16)
        subprocess.run(
            [
                "ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
                "-s", "4x4", "-r", "30", "-i", "pipe:0", "-frames:v", "4",
                "-c:v", "prores_ks", "-profile:v", "4444",
                "-pix_fmt", "yuva444p10le", "-alpha_bits", "16",
                "-y", str(self.video),
            ],
            input=rgba * 4, check=True,
        )

    def make_wav(self, *, bits=16, channels=1):
        wav = self.root / f"声 あんこもんた\u3099んもん！{bits}_{channels}.wav"
        # Leading/trailing silence and a 101-sample timebase, not 4/30s.
        values = [0] * 5 + [1, -1, 100, -100] * 23 + [0] * 4
        with wave.open(str(wav), "wb") as stream:
            stream.setnchannels(channels)
            stream.setsampwidth(bits // 8)
            stream.setframerate(1000)
            if bits == 8:
                data = bytes(128 + x for x in values for _ in range(channels))
            else:
                data = b"".join(
                    x.to_bytes(bits // 8, "little", signed=True)
                    for x in values for _ in range(channels)
                )
            stream.writeframes(data)
        return wav

    def test_all_integer_pcm_widths_mono_and_stereo_preserve_samples(self):
        video_original = self.video.read_bytes()
        for bits in (8, 16, 24, 32):
            for channels in (1, 2):
                with self.subTest(bits=bits, channels=channels):
                    wav = self.make_wav(bits=bits, channels=channels)
                    wav_original = wav.read_bytes()
                    destination = self.root / f"合成{bits}_{channels}.mov"
                    mux_verified_pcm(
                        self.video, wav, destination,
                        expected_samples=101, expected_sample_rate=1000,
                    )
                    streams = json.loads(subprocess.check_output([
                        "ffprobe", "-v", "error", "-show_streams",
                        "-of", "json", str(destination),
                    ]))["streams"]
                    self.assertEqual(len(streams), 2)
                    self.assertEqual(streams[0]["profile"], "4444")
                    self.assertEqual(streams[1]["codec_name"], (
                        "pcm_s8" if bits == 8 else f"pcm_s{bits}le"
                    ))
                    self.assertEqual(int(streams[1]["start_pts"]), 0)
                    self.assertEqual(int(streams[1]["duration_ts"]), 101)
                    self.assertEqual(int(streams[1]["sample_rate"]), 1000)
                    self.assertEqual(int(streams[1]["channels"]), channels)
                    self.assertEqual(wav.read_bytes(), wav_original)
        self.assertEqual(self.video.read_bytes(), video_original)

    def test_preexisting_output_and_mismatched_timing_are_rejected(self):
        wav = self.make_wav()
        target = self.root / "output.mov"
        target.write_bytes(b"preserve")
        with self.assertRaises(FileExistsError):
            mux_verified_pcm(
                self.video, wav, target,
                expected_samples=101, expected_sample_rate=1000,
            )
        self.assertEqual(target.read_bytes(), b"preserve")
        target.unlink()
        with self.assertRaisesRegex(ValueError, "timing differs"):
            mux_verified_pcm(
                self.video, wav, target,
                expected_samples=102, expected_sample_rate=1000,
            )
        self.assertFalse(target.exists())

    def test_verification_failure_removes_stage_without_publishing(self):
        wav = self.make_wav()
        original = wav.read_bytes()
        target = self.root / "failed.mov"
        with patch(
            "tachie_motion.render.pcm_mux._decoded_pcm_digest",
            return_value=(0, "corrupt"),
        ):
            with self.assertRaisesRegex(RuntimeError, "PCM samples"):
                mux_verified_pcm(
                    self.video, wav, target,
                    expected_samples=101, expected_sample_rate=1000,
                )
        self.assertFalse(target.exists())
        self.assertFalse(list(self.root.glob(".tachie-pcm-*.mov")))
        self.assertEqual(wav.read_bytes(), original)

    def test_packet_pts_dts_or_duration_change_rejects_mux(self):
        wav = self.make_wav()
        real_probe = pcm_mux._video_packets
        for changed_field in (1, 2, 3):
            with self.subTest(changed_field=changed_field):
                calls = 0

                def altered_probe(path, ffprobe):
                    nonlocal calls
                    packets = real_probe(path, ffprobe)
                    calls += 1
                    if calls == 2:
                        tampered = list(packets[1])
                        tampered[changed_field] += 1
                        packets[1] = tuple(tampered)
                    return packets

                output = self.root / f"tamper_{changed_field}.mov"
                with patch(
                    "tachie_motion.render.pcm_mux._video_packets",
                    side_effect=altered_probe,
                ):
                    with self.assertRaisesRegex(RuntimeError, "video timing"):
                        mux_verified_pcm(
                            self.video, wav, output,
                            expected_samples=101, expected_sample_rate=1000,
                        )
                self.assertFalse(output.exists())
                self.assertFalse(list(self.root.glob(".tachie-pcm-*.mov")))

    def test_same_length_wav_replacement_after_analysis_is_rejected(self):
        wav = self.make_wav()
        schedule = analyze_wav(wav, fps=30)
        before = wav.read_bytes()
        changed = bytearray(before)
        changed[-1] ^= 1
        wav.write_bytes(changed)
        self.assertEqual(len(wav.read_bytes()), len(before))
        output = self.root / "changed.mov"
        with self.assertRaisesRegex(ValueError, "PCM changed after animation"):
            mux_verified_pcm(
                self.video, wav, output,
                expected_samples=schedule.sample_count,
                expected_sample_rate=schedule.sample_rate,
                expected_channels=schedule.channels,
                expected_sample_width_bits=schedule.sample_width_bits,
                expected_pcm_sha256=schedule.pcm_sha256,
            )
        self.assertFalse(output.exists())

    def test_unsupported_channel_count_is_rejected(self):
        wav = self.make_wav(channels=3)
        target = self.root / "not-supported.mov"
        with self.assertRaisesRegex(ValueError, "mono/stereo"):
            mux_verified_pcm(
                self.video, wav, target,
                expected_samples=101, expected_sample_rate=1000,
            )
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
