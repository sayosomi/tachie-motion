"""Synthetic-only end-to-end tests for manual PSD/WAV mouth animation."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import wave

from PIL import Image, ImageDraw
from psd_tools import PSDImage

from tachie_motion.lipsync.cli import main
from tachie_motion.lipsync.pipeline import export_mouth_animation
from tachie_motion.psd.mouth_variants import render_mouth_variants
from tachie_motion.psd.tree import walk_layers
from tachie_motion.render.probe import inspect_prores
from tachie_motion.render.sequence import encode_prores_sequence


def make_fixture(folder: Path, *, hidden_group: bool = False):
    psd_file = folder / "manual-mouth.psd"
    psd = PSDImage.new(mode="RGB", size=(64, 64), depth=8)
    group = psd.create_group(name="face")
    closed = group.create_pixel_layer(
        Image.new("RGBA", (12, 3), (255, 30, 20, 255)),
        name="mouth", left=15, top=15,
    )
    opened = group.create_pixel_layer(
        Image.new("RGBA", (12, 10), (20, 40, 255, 255)),
        name="mouth", left=15, top=15,
    )
    psd.create_pixel_layer(
        Image.new("RGBA", (20, 20), (100, 180, 80, 255)),
        name="unrelated-body", left=35, top=30,
    )
    closed.visible, opened.visible = True, False
    group.visible = not hidden_group
    psd.save(psd_file)
    imported = PSDImage.open(psd_file)
    layers = [entry for entry in walk_layers(imported) if entry.kind == "pixel"]
    closed_layer = next(x for x in layers if x.name == "mouth" and x.visible)
    open_layer = next(x for x in layers if x.name == "mouth" and not x.visible)
    return (
        psd_file,
        "/".join(map(str, closed_layer.index_path)),
        "/".join(map(str, open_layer.index_path)),
    )


def make_wav(path: Path, samples: list[int], rate: int = 1000) -> None:
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"".join(s.to_bytes(2, "little", signed=True) for s in samples))


class MouthVariantUnitTests(unittest.TestCase):
    def test_two_variants_preserve_other_pixels_and_psd_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            source, closed, opened = make_fixture(folder)
            old_hash = hashlib.sha256(source.read_bytes()).hexdigest()
            c, o = render_mouth_variants(
                source, closed_path=closed, open_path=opened,
                directory=folder / "states", padding=2,
            )
            with Image.open(c) as a, Image.open(o) as b:
                self.assertEqual(a.size, b.size)
                self.assertEqual(a.width % 2, 0)
                self.assertNotEqual(a.tobytes(), b.tobytes())
                self.assertEqual(a.getpixel((a.width - 2, a.height - 2)),
                                 b.getpixel((b.width - 2, b.height - 2)))
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), old_hash)

    def test_padding_zero_odd_crop_height_pads_both_mouth_states(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, closed, opened = make_fixture(root)
            original = source.read_bytes()
            closed_png, open_png = render_mouth_variants(
                source, closed_path=closed, open_path=opened,
                directory=root / "zero-padding", padding=0,
            )
            with Image.open(closed_png) as a, Image.open(open_png) as b:
                # The original leaf union is 40x35 at PSD (15, 15).
                # Extend downward only: stable origin and 40x36 ProRes input.
                self.assertEqual(a.size, (40, 36))
                self.assertEqual(b.size, (40, 36))
                self.assertNotEqual(a.tobytes(), b.tobytes())
                for image in (a, b):
                    # psd-tools may retain RGB under zero alpha.
                    # Opacity, not hidden RGB, defines transparent padding.
                    self.assertEqual(image.getpixel((20, 35))[3], 0)
            self.assertEqual(source.read_bytes(), original)

    def test_rejects_duplicate_missing_group_and_hidden_ancestors(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            source, closed, opened = make_fixture(folder)
            for a, b in ((closed, closed), (closed, "99/2")):
                with self.subTest(a=a,b=b), self.assertRaises(ValueError):
                    render_mouth_variants(
                        source, closed_path=a, open_path=b,
                        directory=folder / "not-published",
                    )
            source2, c2, o2 = make_fixture(folder, hidden_group=True)
            with self.assertRaisesRegex(ValueError, "hidden group"):
                render_mouth_variants(
                    source2, closed_path=c2, open_path=o2,
                    directory=folder / "hidden-output",
                )


class RoundedOtioTests(unittest.TestCase):
    def test_video_ceiling_keeps_sample_exact_audio_and_zero_starts(self):
        from tachie_motion.timeline.media import MovieTiming, WaveTiming
        from tachie_motion.timeline.otio_json import build_rounded_utterance
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            mov, wav = folder / "x.mov", folder / "x.wav"
            mov.touch()
            wav.touch()
            doc = build_rounded_utterance(
                mov, wav, MovieTiming(4, 30), WaveTiming(101, 1000),
            )
            tracks = doc["tracks"]["children"]
            self.assertEqual([x["kind"] for x in tracks], ["Video", "Audio"])
            self.assertEqual([len(x["children"]) for x in tracks], [1, 1])
            self.assertEqual(
                tracks[0]["children"][0]["source_range"]["duration"]["value"], 4
            )
            self.assertEqual(
                tracks[1]["children"][0]["source_range"]["duration"]["value"], 101
            )
            for track in tracks:
                self.assertEqual(
                    track["children"][0]["source_range"]["start_time"]["value"], 0
                )
            self.assertEqual(
                tracks[1]["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"],
                str(wav.resolve()),
            )
            embedded = build_rounded_utterance(
                mov, wav, MovieTiming(4, 30), WaveTiming(101, 1000),
                embedded_audio=True,
            )
            embedded_track = embedded["tracks"]["children"][1]["children"][0]
            self.assertEqual(
                embedded_track["media_references"]["DEFAULT_MEDIA"]["target_url"],
                str(mov.resolve()),
            )
            self.assertNotIn(str(wav.resolve()), json.dumps(embedded))
            with self.assertRaisesRegex(ValueError, "rounded WAV duration"):
                build_rounded_utterance(
                    mov, wav, MovieTiming(3, 30), WaveTiming(101, 1000),
                )


class MouthPipelineProtectionTests(unittest.TestCase):
    def test_existing_output_invalid_binding_and_encoder_failure_do_not_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            psd, closed, opened = make_fixture(folder)
            wav = folder / "voice.wav"
            make_wav(wav, [0] * 100)
            mov, otio = folder / "result.mov", folder / "result.otio"
            mov.write_bytes(b"do not overwrite")
            with self.assertRaises(FileExistsError):
                export_mouth_animation(
                    psd=psd, wav=wav, closed_path=closed, open_path=opened,
                    mov=mov, otio=otio,
                )
            self.assertEqual(mov.read_bytes(), b"do not overwrite")
            mov.unlink()
            with self.assertRaises(ValueError):
                export_mouth_animation(
                    psd=psd, wav=wav, closed_path=closed, open_path=closed,
                    mov=mov, otio=otio,
                )
            self.assertFalse(mov.exists())
            with patch(
                "tachie_motion.lipsync.pipeline.encode_prores_sequence",
                side_effect=RuntimeError("synthetic encoder error"),
            ):
                with self.assertRaisesRegex(RuntimeError, "synthetic encoder error"):
                    export_mouth_animation(
                        psd=psd, wav=wav, closed_path=closed, open_path=opened,
                        mov=mov, otio=otio,
                    )
            self.assertFalse(mov.exists())
            self.assertFalse(otio.exists())
            self.assertFalse(list(folder.glob(".tachie-mouth-*")))

    def test_failed_otio_publication_rolls_back_new_mov(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            psd, closed, opened = make_fixture(folder)
            wav = folder / "voice.wav"
            make_wav(wav, [0] * 100)
            mov, otio = folder / "result.mov", folder / "result.otio"
            with patch(
                "tachie_motion.lipsync.pipeline.encode_prores_sequence"
            ) as encoder, patch(
                "tachie_motion.lipsync.pipeline.mux_verified_pcm",
                side_effect=lambda _mov, _wav, out, **kwargs: out.write_bytes(b"muxed"),
            ), patch(
                "tachie_motion.lipsync.pipeline.write_otio",
                side_effect=OSError("synthetic write failure"),
            ):
                # Simulate a verified staged MOV without requiring an encoder.
                def write_staged(pngs, indices, output, **kwargs):
                    output.write_bytes(b"staged")
                    from types import SimpleNamespace
                    return SimpleNamespace(frames=len(indices), decoded_frames=len(indices))
                encoder.side_effect = write_staged
                with self.assertRaisesRegex(OSError, "synthetic write failure"):
                    export_mouth_animation(
                        psd=psd, wav=wav, closed_path=closed, open_path=opened,
                        mov=mov, otio=otio,
                    )
            self.assertFalse(mov.exists())
            self.assertFalse(otio.exists())
            self.assertFalse(list(folder.glob(".tachie-mouth-*")))

    def test_preexisting_symlink_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            psd, closed, opened = make_fixture(folder)
            wav = folder / "voice.wav"
            make_wav(wav, [0] * 50)
            destination = folder / "existing.mov"
            destination.symlink_to(folder / "nonexistent-target.mov")
            with self.assertRaises(FileExistsError):
                export_mouth_animation(
                    psd=psd, wav=wav, closed_path=closed, open_path=opened,
                    mov=destination, otio=folder / "other.otio",
                )
            self.assertTrue(destination.is_symlink())


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "Real FFmpeg integration required",
)
class MouthPipelineIntegrationTests(unittest.TestCase):
    def test_manual_psd_wav_to_full_fidelity_mov_and_otio(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            psd, closed, opened = make_fixture(folder)
            # Deliberately include spaces, Japanese characters and NFD dakuten.
            wav = folder / "声 あんこもんた\u3099んもん！.wav"
            make_wav(wav, [0] * 34 + [16000] * 33 + [0] * 33 + [16000])
            original = (psd.read_bytes(), wav.read_bytes())
            mov, otio = folder / "speech.mov", folder / "speech.otio"
            code = main([
                "--psd", str(psd), "--wav", str(wav),
                "--mouth-closed", closed, "--mouth-open", opened,
                "--fps", "30", "--output-mov", str(mov),
                "--output-otio", str(otio),
            ])
            self.assertEqual(code, 0)
            self.assertTrue(mov.is_file())
            self.assertTrue(otio.is_file())
            doc = json.loads(otio.read_text(encoding="utf-8"))
            tracks = doc["tracks"]["children"]
            self.assertEqual(tracks[0]["children"][0]["source_range"]["duration"]["value"], 4)
            self.assertEqual(tracks[1]["children"][0]["source_range"]["duration"]["value"], 101)
            self.assertEqual(tracks[1]["children"][0]["source_range"]["duration"]["rate"], 1000)
            self.assertEqual(
                tracks[0]["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"],
                mov.resolve().as_uri(),
            )
            self.assertEqual(
                tracks[1]["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"],
                str(mov.resolve()),
            )
            # One PCM-bearing MOV is referenced by both OTIO tracks; WAV is not.
            self.assertEqual(set(folder.iterdir()), {psd, wav, mov, otio})
            self.assertEqual((psd.read_bytes(), wav.read_bytes()), original)
            # The writer's independently decoded checker already confirmed
            # source-state fidelity in each of the four scheduled frames.
            self.assertFalse(list(folder.glob(".tachie-mouth-*")))

    def test_odd_height_crop_produces_verified_even_height_mov(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, closed, opened = make_fixture(root)
            wav = root / "voice.wav"
            make_wav(wav, [0] * 34 + [16000] * 34 + [0] * 33)
            original = (source.read_bytes(), wav.read_bytes())
            mov, otio = root / "odd-crop.mov", root / "odd-crop.otio"
            result = export_mouth_animation(
                psd=source, wav=wav, closed_path=closed, open_path=opened,
                mov=mov, otio=otio, fps=30, padding=0,
            )
            self.assertEqual((result.video.width, result.video.height), (40, 36))
            self.assertEqual(result.video.frames, 4)
            self.assertEqual(result.video.decoded_frames, 4)
            self.assertTrue(mov.is_file())
            self.assertTrue(otio.is_file())
            self.assertEqual((source.read_bytes(), wav.read_bytes()), original)
            self.assertFalse(list(root.glob(".tachie-mouth-*")))

    def test_wrong_frame_state_mapping_fails_independent_verifier(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            pngs = []
            for name, color in (("closed", (240, 20, 20, 255)),
                                ("open", (20, 20, 240, 255))):
                image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
                ImageDraw.Draw(image).rectangle((6, 6, 50, 50), fill=color)
                path = folder / (name + ".png")
                image.save(path)
                pngs.append(path)
            output = folder / "video.mov"
            report = encode_prores_sequence(pngs, [0, 1, 0, 1], output, fps=30)
            self.assertEqual(report.decoded_frames, 4)
            from tachie_motion.render.prores import read_rgba_states
            dimensions, states = read_rgba_states(pngs)
            with self.assertRaisesRegex(RuntimeError, "RGB content mismatch|block|tile"):
                inspect_prores(
                    output, expected_size=dimensions, expected_frames=4,
                    expected_fps=30, source_states=states, state_indices=[1, 0, 1, 0],
                )


if __name__ == "__main__":
    unittest.main()
