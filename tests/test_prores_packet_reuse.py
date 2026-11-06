"""Issue #8: opt-in repeated key packet reuse must preserve all frame gates."""

from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

from tachie_motion.render.packet_reuse import (
    ReuseUnavailable, _inspect, _validate, encode_reused,
)
from tachie_motion.render.prores import encode_prores, read_rgba_states


def _inputs(folder: Path, *, states: int = 2) -> list[Path]:
    paths = []
    for i in range(states):
        path = folder / f"state_{i}.png"
        image = Image.new("RGBA", (48, 48), (0, 0, 0, 0))
        ImageDraw.Draw(image).rectangle(
            (5, 5, 42, 42), fill=(80 + i * 20, 30, 50, 255)
        )
        image.save(path)
        paths.append(path)
    return paths


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "FFmpeg and FFprobe required",
)
class PacketReuseIntegrationTests(unittest.TestCase):
    def test_real_opt_in_reuse_equal_packets_full_quality_24_30_60(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            states = _inputs(root)
            for fps in (24, 30, 60):
                with self.subTest(fps=fps):
                    regular = root / f"regular_{fps}.mov"
                    reused = root / f"reused_{fps}.mov"
                    orig = encode_prores(
                        states, regular, fps=fps, frames_per_state=4
                    )
                    # Optimization MUST execute; ordinary encoding must not
                    # make this test pass when packet reuse is unavailable.
                    with patch(
                        "tachie_motion.render.prores._encode_regular",
                        side_effect=AssertionError("UNEXPECTED_FALLBACK"),
                    ) as fallback:
                        opt = encode_prores(
                            states, reused, fps=fps, frames_per_state=4,
                            reuse_packets=True
                        )
                    fallback.assert_not_called()
                    self.assertEqual(orig, opt)
                    self.assertEqual(opt.decoded_frames, 8)
                    std_stream, std_packets = _inspect(regular, ffprobe="ffprobe")
                    opt_stream, opt_packets = _inspect(reused, ffprobe="ffprobe")
                    self.assertEqual(
                        _validate(
                            std_stream, std_packets, dimensions=(48, 48),
                            fps=fps, frames=8, final=True,
                        ),
                        _validate(
                            opt_stream, opt_packets, dimensions=(48, 48),
                            fps=fps, frames=8, final=True,
                        ),
                    )
            self.assertEqual(list(root.glob(".tachie-*")), [])

    def test_opt_in_verified_export_preserves_wav_otio_sync(self):
        import json
        from fractions import Fraction
        from tachie_motion.timeline.test_tone import make_test_tone
        from tachie_motion.timeline.verified_export import export_verified_utterance

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            states = _inputs(root)
            wav = root / "voice.wav"
            make_test_tone(wav, duration=Fraction(1, 5))
            mov = root / "video.mov"
            otio = root / "timeline.otio"
            with patch(
                "tachie_motion.render.prores._encode_regular",
                side_effect=AssertionError("UNEXPECTED_FALLBACK"),
            ) as fallback:
                report = export_verified_utterance(
                    states, mov=mov, wav=wav, otio=otio, fps=30,
                    frames_per_state=3, reuse_packets=True,
                )
            fallback.assert_not_called()
            self.assertEqual(report.decoded_frames, 6)
            doc = json.loads(otio.read_text(encoding="utf-8"))
            tracks = doc["tracks"]["children"]
            self.assertEqual(
                tracks[0]["children"][0]["source_range"]["duration"]["value"], 6
            )
            self.assertEqual(
                tracks[1]["children"][0]["source_range"]["duration"]["value"],
                9600,
            )
            self.assertEqual(list(root.glob(".tachie-*")), [])

    def test_reuse_feature_unavailable_falls_back_and_still_verifies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            states = _inputs(root)
            output = root / "fallback.mov"
            with patch(
                "tachie_motion.render.packet_reuse.encode_reused",
                side_effect=ReuseUnavailable("Missing setts filter"),
            ) as fast:
                report = encode_prores(
                    states, output, reuse_packets=True,
                    frames_per_state=4
                )
            fast.assert_called_once()
            self.assertEqual(report.decoded_frames, 8)
            self.assertTrue(output.is_file())
            self.assertEqual(list(root.glob(".tachie-*")), [])

    def test_hold_one_and_too_many_states_use_original_encoder(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            two = _inputs(root)
            result = encode_prores(
                two, root / "hold1.mov", frames_per_state=1,
                reuse_packets=True
            )
            self.assertEqual(result.decoded_frames, 2)
            nine = _inputs(root, states=9)
            result = encode_prores(
                nine, root / "nine.mov", frames_per_state=3,
                reuse_packets=True
            )
            self.assertEqual(result.decoded_frames, 27)
            self.assertEqual(list(root.glob(".tachie-*")), [])

    def test_corrupt_final_packet_never_published_even_with_good_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            states = _inputs(root)
            target = root / "never.mov"
            from tachie_motion.render import packet_reuse
            original = packet_reuse._validate

            def reject_final(stream, packets, **kwargs):
                if kwargs["final"]:
                    raise RuntimeError("Unsafe reused ProRes payload mismatch")
                return original(stream, packets, **kwargs)

            with patch.object(
                packet_reuse, "_validate", side_effect=reject_final
            ):
                with self.assertRaisesRegex(RuntimeError, "payload mismatch"):
                    encode_prores(
                        states, target, reuse_packets=True,
                        frames_per_state=3
                    )
            self.assertFalse(target.exists())
            self.assertEqual(list(root.glob(".tachie-*")), [])

    def test_actual_packet_metadata_mutation_fails_closed(self):
        # Run the real FFmpeg encoder and the production validator.
        # Only alter ffprobe's response for the final assembled MOV.
        # Unlike a mocked _validate, this tests real hash/count/PTS guards.
        from tachie_motion.render import packet_reuse

        real_inspect = packet_reuse._inspect
        for defect in ("digest", "missing", "timestamp"):
            with self.subTest(defect=defect):
                with tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    states = _inputs(root)
                    destination = root / "must_not_publish.mov"
                    saw_final = []

                    def altered_probe(video, *, ffprobe):
                        stream, entries = real_inspect(video, ffprobe=ffprobe)
                        if video.name.startswith(".tachie-prores-"):
                            saw_final.append(True)
                            entries = [dict(item) for item in entries]
                            if defect == "digest":
                                previous = entries[0]["data_hash"]
                                candidate = "SHA256:" + "0" * 64
                                if candidate == previous:
                                    candidate = "SHA256:" + "f" * 64
                                entries[0]["data_hash"] = candidate
                            elif defect == "missing":
                                entries.pop(0)
                            else:
                                entries[0]["pts"] = int(entries[0]["pts"]) + 1
                        return stream, entries

                    with patch.object(
                        packet_reuse, "_inspect", side_effect=altered_probe
                    ), patch(
                        "tachie_motion.render.prores._encode_regular",
                        side_effect=AssertionError("UNEXPECTED_FALLBACK"),
                    ) as fallback:
                        with self.assertRaisesRegex(
                            RuntimeError, "Unsafe reused ProRes"
                        ):
                            encode_prores(
                                states, destination, reuse_packets=True,
                                frames_per_state=3,
                            )
                    self.assertTrue(saw_final)
                    fallback.assert_not_called()
                    self.assertFalse(destination.exists())
                    self.assertEqual(list(root.glob(".tachie-*")), [])

    def test_no_clobber_if_another_writer_creates_output_before_publish(self):
        from tachie_motion.render import prores

        original_link = prores.os.link
        for reuse in (False, True):
            with self.subTest(reuse_packets=reuse):
                with tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    target = root / "race.mov"
                    states = _inputs(root)
                    invoked = []

                    def competitor_wins(source, destination):
                        invoked.append(True)
                        Path(destination).write_bytes(b"COMPETING USER DATA")
                        return original_link(source, destination)

                    with patch.object(
                        prores.os, "link", side_effect=competitor_wins
                    ):
                        with self.assertRaises(FileExistsError):
                            encode_prores(
                                states, target, frames_per_state=3,
                                reuse_packets=reuse,
                            )
                    self.assertTrue(invoked)
                    self.assertEqual(target.read_bytes(), b"COMPETING USER DATA")
                    self.assertEqual(list(root.glob(".tachie-*")), [])

    def test_unsupported_hard_link_fails_closed_without_overwriting(self):
        import errno
        from tachie_motion.render import prores

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "no_publication.mov"
            with patch.object(
                prores.os, "link",
                side_effect=OSError(errno.ENOTSUP, "Hard links unsupported"),
            ):
                with self.assertRaises(OSError):
                    encode_prores(
                        _inputs(root), target, reuse_packets=False,
                        frames_per_state=3,
                    )
            self.assertFalse(target.exists())
            self.assertEqual(list(root.glob(".tachie-*")), [])

    def test_malformed_single_probe_triggers_verified_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            states = _inputs(root)
            target = root / "normal.mov"
            with patch(
                "tachie_motion.render.packet_reuse._inspect",
                side_effect=ReuseUnavailable("malformed ffprobe JSON"),
            ):
                report = encode_prores(
                    states, target, reuse_packets=True, frames_per_state=3
                )
            self.assertEqual(report.decoded_frames, 6)
            self.assertEqual(list(root.glob(".tachie-*")), [])

    def test_opt_in_never_overwrites_existing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "user.mov"
            target.write_bytes(b"KEEP THIS")
            with self.assertRaises(FileExistsError):
                encode_prores(
                    _inputs(root), target, reuse_packets=True,
                    frames_per_state=4
                )
            self.assertEqual(target.read_bytes(), b"KEEP THIS")
            self.assertEqual(list(root.glob(".tachie-*")), [])


class PacketReuseBoundaryTests(unittest.TestCase):
    def test_invalid_source_packet_flags_are_unavailable(self):
        stream = {
            "codec_name": "prores", "profile": "4444",
            "pix_fmt": "yuva444p12le",
            "width": 48, "height": 48, "nb_frames": "1",
            "r_frame_rate": "30/1", "avg_frame_rate": "30/1",
            "time_base": "1/15360",
        }
        packet = {
            "pts": 0, "dts": 0, "duration": 512,
            "flags": "K_C", "data_hash": "SHA256:abc",
        }
        with self.assertRaises(ReuseUnavailable):
            _validate(stream, [packet], dimensions=(48, 48),
                      fps=30, frames=1, final=False)

    def test_invalid_output_packet_flags_fail_closed(self):
        stream = {
            "codec_name": "prores", "profile": "4444",
            "pix_fmt": "yuva444p12le", "width": 48, "height": 48,
            "nb_frames": "1", "r_frame_rate": "30/1",
            "avg_frame_rate": "30/1", "time_base": "1/15360",
            "duration": "0.033333",
        }
        packet = {
            "pts": 0, "dts": 0, "duration": 512,
            "flags": "KD_", "data_hash": "SHA256:abc",
        }
        with self.assertRaisesRegex(RuntimeError, "Unsafe reused"):
            _validate(stream, [packet], dimensions=(48, 48),
                      fps=30, frames=1, final=True)

    def test_strict_sha256_digest_format(self):
        stream = {
            "codec_name": "prores", "profile": "4444",
            "pix_fmt": "yuva444p12le",
            "width": 48, "height": 48, "nb_frames": "1",
            "r_frame_rate": "30/1", "avg_frame_rate": "30/1",
            "time_base": "1/15360", "duration": "0.033333",
        }
        valid = "SHA256:" + "a" * 64
        packet = {
            "pts": 0, "dts": 0, "duration": 512,
            "flags": "K_", "data_hash": valid,
        }
        self.assertEqual(
            _validate(
                stream, [packet], dimensions=(48, 48),
                fps=30, frames=1, final=False,
            ), [valid]
        )
        for bad in (
            "", "SHA256:", "SHA256:abc", "SHA256:" + "a" * 63,
            "SHA256:" + "a" * 65, "SHA256:" + "g" * 64,
            "SHA256:" + "a" * 64 + "-junk",
            "sha256:" + "a" * 64, None, 1234,
        ):
            with self.subTest(digest=bad):
                candidate = {**packet, "data_hash": bad}
                with self.assertRaisesRegex(
                    ReuseUnavailable, "Malformed packet SHA256"
                ):
                    _validate(
                        stream, [candidate], dimensions=(48, 48),
                        fps=30, frames=1, final=False,
                    )
                with self.assertRaisesRegex(
                    RuntimeError, "Unsafe reused ProRes packet output"
                ):
                    _validate(
                        stream, [candidate], dimensions=(48, 48),
                        fps=30, frames=1, final=True,
                    )

    def test_malformed_metadata_is_not_a_shortcut(self):
        stream = {
            "codec_name": "prores", "profile": "4444",
            "pix_fmt": None,
        }
        with self.assertRaises(ReuseUnavailable):
            _validate(stream, [], dimensions=(48, 48),
                      fps=30, frames=1, final=False)

    def test_reuse_refuses_invalid_rgba_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            with self.assertRaisesRegex(ValueError, "RGBA state size"):
                encode_reused(
                    [b"tiny", b"short"], (48, 48), fps=30,
                    hold=4, destination=path / "out.mov"
                )
            self.assertEqual(list(path.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
