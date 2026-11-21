"""Silent idle backend tests with synthetic PSD, never private materials."""

import asyncio
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from psd_tools import PSDImage

from tachie_motion.web.idle_motion import export_idle_motion
from tachie_motion.web.service import describe_psd
from test_web_api import fixture


class IdleMotionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.psd_path, self.wav_path, _, _ = fixture(self.root)
        psd = PSDImage.open(self.psd_path)
        eye_group = psd.create_group(name="eyes")
        eye_group.create_pixel_layer(
            Image.new("RGBA", (14, 7), (220, 100, 50, 255)),
            name="open eye", left=3, top=35,
        )
        shut = eye_group.create_pixel_layer(
            Image.new("RGBA", (14, 7), (30, 70, 210, 255)),
            name="closed eye", left=3, top=35,
        )
        shut.visible = False
        psd.save(self.psd_path)
        info = describe_psd(str(self.psd_path))
        paths = {item["name"]: item["path"] for item in info["layers"]}
        self.closed_eyes = {
            "opened": [],
            "closed": [
                {"path": paths["open eye"], "visible": False},
                {"path": paths["closed eye"], "visible": True},
            ],
        }
        self.data = {
            "psd_path": self.psd_path,
            "fingerprint": info["fingerprint"],
            "source_identity": info["source_identity"],
            "layers": [{"path": item["path"], "visible": item["visible"]}
                       for item in info["layers"]],
            "mov": self.root / "待機.mov",
            "frame_count": 4,
            "fps": 30,
        }
        self.eye_group = [paths["eyes"]]
        self.originals = self.psd_path.read_bytes(), self.wav_path.read_bytes()

    def export(self, **kwargs):
        return export_idle_motion(**{**self.data, **kwargs})

    @staticmethod
    def decoded_video(path):
        size = subprocess.run([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path),
        ], check=True, capture_output=True, text=True).stdout.strip()
        width, height = (int(value) for value in size.split(","))
        raw = subprocess.run([
            "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0",
            "-pix_fmt", "rgba", "-f", "rawvideo", "-",
        ], check=True, capture_output=True).stdout
        step = width * height * 4
        assert len(raw) % step == 0
        return [raw[i:i + step] for i in range(0, len(raw), step)]

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_static_silent_mov_has_exact_frames_and_unchanged_sources(self):
        for fps in (24, 30, 60):
            with self.subTest(fps=fps):
                mov = self.root / f"static_{fps}.mov"
                result = self.export(mov=mov, fps=fps, frame_count=3)
                self.assertEqual(result, {
                    "mov": str(mov), "frames": 3, "fps": fps, "audio": False,
                })
                frames = self.decoded_video(mov)
                self.assertEqual(len(frames), 3)
                self.assertEqual(frames[0], frames[1])
                self.assertEqual(frames[1], frames[2])
                self.assertEqual(subprocess.run([
                    "ffprobe", "-v", "error", "-select_streams", "a",
                    "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(mov),
                ], check=True, capture_output=True, text=True).stdout, "")
                self.assertFalse(mov.with_suffix(".otio").exists())
        self.assertEqual((self.psd_path.read_bytes(), self.wav_path.read_bytes()),
                         self.originals)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_optional_blink_changes_only_scheduled_frames(self):
        result = self.export(
            blink_enabled=True, eyes=self.closed_eyes,
            eye_groups=self.eye_group,
            blink_timing={
                "interval_frames": 2, "closed_frames": 1,
                "jitter_frames": 0, "phase_frames": 1, "seed": 19,
            },
        )
        self.assertFalse(result["audio"])
        frames = self.decoded_video(self.data["mov"])
        self.assertEqual(len(frames), 4)
        self.assertEqual(frames[0], frames[2])
        self.assertEqual(frames[1], frames[3])
        self.assertNotEqual(frames[0], frames[1])
        self.assertEqual((self.psd_path.read_bytes(), self.wav_path.read_bytes()),
                         self.originals)

    def test_rejects_invalid_inputs_before_publication(self):
        invalid = (
            {"frame_count": 0}, {"frame_count": True},
            {"frame_count": 216_001}, {"fps": 25},
            {"blink_enabled": 1}, {"blink_enabled": True},
            {"mov": self.root / "../evil.mov"},
            {"mov": self.root / ".hidden.mov"},
            {"mov": Path("relative.mov")},
            {"fingerprint": "invalid"}, {"layers": []},
            {"source_identity": "outdated"},
        )
        for changes in invalid:
            with self.subTest(changes=changes):
                with self.assertRaises((ValueError, TypeError)):
                    self.export(**changes)
        self.assertFalse((self.root / "待機.mov").exists())

    def test_existing_output_and_otio_are_never_replaced(self):
        mov = self.data["mov"]
        mov.write_bytes(b"other MOV")
        with self.assertRaises(FileExistsError):
            self.export()
        self.assertEqual(mov.read_bytes(), b"other MOV")
        mov.with_suffix(".otio").write_bytes(b"timeline")
        with self.assertRaises(ValueError):
            self.export(conflict_policy="overwrite")
        self.assertEqual(mov.read_bytes(), b"other MOV")
        self.assertEqual(mov.with_suffix(".otio").read_bytes(), b"timeline")

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_overwrite_retains_old_mov_and_publishes_verified_silent_video(self):
        mov = self.data["mov"]
        mov.write_bytes(b"old bytes")
        result = self.export(conflict_policy="overwrite", frame_count=2)
        self.assertEqual(len(self.decoded_video(mov)), 2)
        self.assertIn("previous MOV retained", result["warning"])
        archives = list(self.root.glob(".待機.mov.single-backup-retained-*"))
        self.assertEqual(len(archives), 1)
        self.assertEqual((archives[0] / "saved").read_bytes(), b"old bytes")
        self.assertEqual((self.psd_path.read_bytes(), self.wav_path.read_bytes()),
                         self.originals)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_late_competing_file_is_preserved_and_no_false_completion(self):
        mov = self.data["mov"]
        progress = []

        def competing_writer(stage, percent):
            progress.append(percent)
            if percent == 90:
                mov.write_bytes(b"someone else's file")

        with self.assertRaises(FileExistsError):
            self.export(on_progress=competing_writer)
        self.assertEqual(mov.read_bytes(), b"someone else's file")
        self.assertNotIn(100, progress)
        self.assertEqual((self.psd_path.read_bytes(), self.wav_path.read_bytes()),
                         self.originals)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_late_progress_failure_does_not_claim_export_failed(self):
        def observer(stage, percent):
            if percent == 100:
                raise RuntimeError("UI disconnected")

        result = self.export(on_progress=observer, frame_count=1)
        self.assertEqual(result["frames"], 1)
        self.assertIn("Progress observer failed", result["warning"])
        self.assertEqual(len(self.decoded_video(self.data["mov"])), 1)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_postcommit_cancelled_error_is_warning_but_keyboard_interrupt_is_not_swallowed(self):
        def cancelled_on_completion(stage, percent):
            if percent == 100:
                raise asyncio.CancelledError("UI task was cancelled")

        result = self.export(on_progress=cancelled_on_completion)
        self.assertIn("CancelledError", result["warning"])
        self.assertEqual(len(self.decoded_video(self.data["mov"])), 4)

        other = self.root / "keyboard.mov"

        def interrupted(stage, percent):
            if percent == 100:
                raise KeyboardInterrupt()

        with self.assertRaises(KeyboardInterrupt):
            self.export(mov=other, on_progress=interrupted)
        self.assertEqual(len(self.decoded_video(other)), 4)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_verified_stage_mutation_and_replacement_before_publication_are_refused(self):
        for replace in (False, True):
            with self.subTest(replace=replace):
                mov = self.root / f"stage_{int(replace)}.mov"

                def tamper(stage, percent):
                    if percent != 90:
                        return
                    staged = next(self.root.glob(".tachie-idle-*/staged.mov"))
                    if replace:
                        other = staged.with_name("outsider.mov")
                        other.write_bytes(b"not a verified movie")
                        os.replace(other, staged)
                    else:
                        staged.write_bytes(b"not a verified movie")

                with self.assertRaises(RuntimeError):
                    self.export(mov=mov, on_progress=tamper)
                self.assertFalse(mov.exists())
                self.assertEqual(list(self.root.glob(".tachie-idle-*")), [])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_tamper_between_precheck_and_link_is_quarantined_not_successful(self):
        actual_link = os.link

        def corrupt_before_link(source, target, *args, **kwargs):
            if Path(source).name == "staged.mov":
                Path(source).write_bytes(b"broken after precheck")
            return actual_link(source, target, *args, **kwargs)

        with patch("tachie_motion.web.solo_output.os.link",
                   side_effect=corrupt_before_link):
            with self.assertRaisesRegex(RuntimeError, "quarantined"):
                self.export()
        self.assertFalse(self.data["mov"].exists())
        self.assertEqual(
            (self.root / ".待機.mov.single-backup" / "uncommitted").read_bytes(),
            b"broken after precheck",
        )

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_source_changed_after_independent_decode_before_encoder_link(self):
        from tachie_motion.render.probe import inspect_prores

        def tamper_after_verifier(path, **kwargs):
            report = inspect_prores(path, **kwargs)
            Path(path).write_bytes(b"tampered after valid decode")
            return report

        with patch("tachie_motion.render.sequence.inspect_prores",
                   side_effect=tamper_after_verifier):
            with self.assertRaisesRegex(RuntimeError, "Verified media changed"):
                self.export()
        self.assertFalse(self.data["mov"].exists())

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_verified_stage_corruption_during_overwrite_restores_prior_mov(self):
        mov = self.data["mov"]
        mov.write_bytes(b"prior intact media")
        original_link = os.link

        def corrupt_on_publish(source, target, *args, **kwargs):
            if Path(source).name == "staged.mov":
                Path(source).write_bytes(b"invalid encoded file")
            return original_link(source, target, *args, **kwargs)

        with patch("tachie_motion.web.solo_output.os.link",
                   side_effect=corrupt_on_publish):
            with self.assertRaisesRegex(RuntimeError, "Verified media changed"):
                self.export(conflict_policy="overwrite")
        self.assertEqual(mov.read_bytes(), b"prior intact media")
        archives = list(self.root.glob(".待機.mov.single-backup-retained-*"))
        self.assertEqual(len(archives), 1)
        self.assertEqual((archives[0] / "uncommitted").read_bytes(),
                         b"invalid encoded file")

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_replaced_psd_with_identical_size_and_mtime_is_refused(self):
        old_stat = self.psd_path.stat()
        other = self.root / "replacement.psd"
        other.write_bytes(self.psd_path.read_bytes())
        os.utime(other, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))

        def replace_psd(stage, percent):
            if percent == 90:
                os.replace(other, self.psd_path)

        with self.assertRaisesRegex(ValueError, "PSD identity changed"):
            self.export(on_progress=replace_psd)
        self.assertFalse(self.data["mov"].exists())
        self.assertNotEqual(self.psd_path.stat().st_ino, old_stat.st_ino)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_psd_same_size_and_restored_mtime_change_is_refused(self):
        original_stat = self.psd_path.stat()
        original = self.psd_path.read_bytes()

        def change_psd(stage, percent):
            if percent != 90:
                return
            self.psd_path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
            os.utime(self.psd_path, ns=(original_stat.st_atime_ns,
                                        original_stat.st_mtime_ns))
            self.assertEqual(self.psd_path.stat().st_mtime_ns,
                             original_stat.st_mtime_ns)

        with self.assertRaisesRegex(ValueError, "PSD identity changed"):
            self.export(on_progress=change_psd)
        self.assertFalse(self.data["mov"].exists())
        self.assertNotEqual(self.psd_path.read_bytes(), original)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_existing_mov_same_size_and_restored_mtime_change_is_refused(self):
        mov = self.data["mov"]
        mov.write_bytes(b"OLD_DATA")
        original_stat = mov.stat()

        def external_write(stage, percent):
            if percent != 90:
                return
            mov.write_bytes(b"NEW_DATA")
            os.utime(mov, ns=(original_stat.st_atime_ns,
                              original_stat.st_mtime_ns))

        with self.assertRaisesRegex(FileExistsError, "content changed"):
            self.export(conflict_policy="overwrite", on_progress=external_write)
        self.assertEqual(mov.read_bytes(), b"NEW_DATA")
        self.assertEqual(list(self.root.glob(".待機.mov.single-backup*")), [])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_cancel_and_source_mutation_never_publish(self):
        cancelled = False

        def on_progress(stage, percent):
            nonlocal cancelled
            if percent == 70:
                cancelled = True

        def check_cancel():
            if cancelled:
                raise RuntimeError("Cancelled")

        with self.assertRaisesRegex(RuntimeError, "Cancelled"):
            self.export(on_progress=on_progress, check_cancel=check_cancel)
        self.assertFalse(self.data["mov"].exists())

        fingerprint = self.data["fingerprint"]
        with patch("tachie_motion.web.idle_motion.psd_snapshot_token",
                   side_effect=[fingerprint, "changed"]):
            with self.assertRaisesRegex(ValueError, "PSD changed"):
                self.export()
        self.assertFalse(self.data["mov"].exists())
        self.assertEqual((self.psd_path.read_bytes(), self.wav_path.read_bytes()),
                         self.originals)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg required")
    def test_cancel_after_verification_still_blocks_publication(self):
        cancelling = False

        def on_progress(stage, percent):
            nonlocal cancelling
            if percent == 90:
                cancelling = True

        def check_cancel():
            if cancelling:
                raise RuntimeError("Cancelled before publication")

        with self.assertRaisesRegex(RuntimeError, "Cancelled before publication"):
            self.export(on_progress=on_progress, check_cancel=check_cancel)
        self.assertFalse(self.data["mov"].exists())


if __name__ == "__main__":
    unittest.main()
