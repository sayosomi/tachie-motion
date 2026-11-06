"""Synthetic local web API tests. No user-owned media is included."""

import base64
import importlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import wave

from PIL import Image
from psd_tools import PSDImage

try:
    from fastapi.testclient import TestClient
    import httpx2  # noqa: F401; required by current Starlette TestClient
except (ImportError, RuntimeError):
    TestClient = None

from tachie_motion.psd.tree import walk_layers
from tachie_motion.web.service import describe_psd, preview_mouth, describe_wav
from tachie_motion.web.origin import configured_tailscale_origin


def fixture(folder: Path):
    source = folder / "キャラ.psd"
    psd = PSDImage.new(mode="RGB", size=(64, 64), depth=8)
    face = psd.create_group(name="face")
    closed = face.create_pixel_layer(
        Image.new("RGBA", (14, 4), (240, 80, 50, 255)), name="mouth", left=14, top=14
    )
    opened = face.create_pixel_layer(
        Image.new("RGBA", (14, 12), (55, 30, 245, 255)), name="mouth", left=14, top=14
    )
    closed.visible, opened.visible = True, False
    face.visible = True
    psd.create_pixel_layer(
        Image.new("RGBA", (25, 25), (25, 180, 70, 255)),
        name="body", left=30, top=30,
    )
    psd.save(source)
    layers = [layer for layer in walk_layers(PSDImage.open(source))
              if layer.kind == "pixel" and layer.name == "mouth"]
    closed_path = "/".join(map(str, next(x.index_path for x in layers if x.visible)))
    open_path = "/".join(map(str, next(x.index_path for x in layers if not x.visible)))
    wav = folder / "声 た\u3099んもん.wav"
    with wave.open(str(wav), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(1000)
        writer.writeframes(b"\x00\x00" * 34 + b"\xff\x3f" * 34 + b"\x00\x00" * 33)
    return source, wav, closed_path, open_path


class WebServiceTests(unittest.TestCase):
    def test_tailnet_origin_requires_explicit_canonical_https_host_and_port(self):
        with patch.dict(os.environ, {"TACHIE_TAILSCALE_ORIGIN": ""}):
            self.assertIsNone(configured_tailscale_origin())
        good = "https://example-node.my-tailnet.ts.net:8443"
        with patch.dict(os.environ, {"TACHIE_TAILSCALE_ORIGIN": good}):
            self.assertEqual(configured_tailscale_origin(), good)
        for invalid in (
            "http://example-node.my-tailnet.ts.net:8443",
            "https://example-node.my-tailnet.ts.net:443",
            "https://evil.example.com:8443",
            "https://example-node.my-tailnet.ts.net:8443/",
            "https://example-node.my-tailnet.ts.net:8443/path",
            "https://user@example-node.my-tailnet.ts.net:8443",
            "https://example-node.my-tailnet.ts.net:not-a-port",
            "https://example-node.my-tailnet.ts.net:8443?bad=1",
        ):
            with self.subTest(invalid=invalid), patch.dict(
                os.environ, {"TACHIE_TAILSCALE_ORIGIN": invalid}
            ):
                with self.assertRaisesRegex(ValueError, "TACHIE_TAILSCALE_ORIGIN"):
                    configured_tailscale_origin()

    def test_psd_tree_and_preview_keep_source_immutable(self):
        with tempfile.TemporaryDirectory() as temp:
            psd, wav, closed, opened = fixture(Path(temp))
            original = psd.read_bytes()
            info = describe_psd(str(psd))
            self.assertEqual((info["width"], info["height"]), (64, 64))
            self.assertEqual(len([x for x in info["layers"] if x["name"] == "mouth"]), 2)
            self.assertTrue(info["preview"].startswith("data:image/png;base64,"))
            a = preview_mouth(str(psd), closed, opened, "closed")["preview"]
            b = preview_mouth(str(psd), closed, opened, "open")["preview"]
            self.assertNotEqual(base64.b64decode(a.split(",")[1]), base64.b64decode(b.split(",")[1]))
            self.assertEqual(psd.read_bytes(), original)
            self.assertEqual(describe_wav(str(wav))["samples"], 101)

    def test_reject_non_absolute_and_missing_sources_and_invalid_binding(self):
        with tempfile.TemporaryDirectory() as temp:
            psd, _, closed, opened = fixture(Path(temp))
            with self.assertRaisesRegex(ValueError, "absolute"):
                describe_psd("something.psd")
            with self.assertRaises(ValueError):
                describe_psd(str(Path(temp) / "not-present.psd"))
            with self.assertRaisesRegex(ValueError, "distinct"):
                preview_mouth(str(psd), closed, closed, "open")
            with self.assertRaises(ValueError):
                preview_mouth(str(psd), closed, opened, "other")


@unittest.skipUnless(TestClient is not None, "httpx test extra required")
class WebApiTests(unittest.TestCase):
    def setUp(self):
        from tachie_motion.web.app import app
        self.client = TestClient(app, base_url="http://127.0.0.1:8765")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.psd, self.wav, self.closed, self.opened = fixture(self.root)

    def json_post(self, endpoint, body, **kwargs):
        return self.client.post(endpoint, json=body, **kwargs)

    def test_preset_base_preview_http_guards_and_original_immutability(self):
        metadata = describe_psd(str(self.psd))
        original = self.psd.read_bytes()
        layers = [
            {"path": layer["path"], "visible": layer["visible"]}
            for layer in metadata["layers"]
        ]
        body = {
            "path": str(self.psd),
            "fingerprint": metadata["fingerprint"],
            "layers": layers,
        }
        result = self.json_post("/api/preset-preview", body)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertTrue(result.json()["preview"].startswith("data:image/png;base64,"))
        self.assertEqual(self.psd.read_bytes(), original)
        self.assertEqual(
            self.json_post("/api/preset-preview", body,
                           headers={"Origin": "https://evil.example"}).status_code, 403
        )
        self.assertEqual(
            self.json_post("/api/preset-preview", dict(body, fingerprint="wrong")).status_code, 400
        )
        self.assertEqual(
            self.json_post("/api/preset-preview", dict(body, layers=layers[:-1])).status_code, 400
        )
        self.assertEqual(self.psd.read_bytes(), original)

    def test_host_origin_json_and_source_validation(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        body = {"path": str(self.psd)}
        self.assertEqual(self.json_post("/api/psd", body).status_code, 200)
        self.assertEqual(self.json_post("/api/psd", body, headers={
            "Origin": "http://evil.example"}).status_code, 403)
        self.assertEqual(self.json_post("/api/psd", body, headers={
            "Origin": "null"}).status_code, 403)
        self.assertEqual(self.json_post("/api/psd", body, headers={
            "Origin": "http://127.0.0.1:invalid"}).status_code, 403)
        self.assertEqual(self.json_post("/api/psd", body, headers={
            "Origin": "http://127.0.0.1:8765"}).status_code, 200)
        self.assertEqual(self.json_post("/api/psd", body, headers={
            "Host": "evil.example"}).status_code, 400)
        self.assertEqual(self.client.post(
            "/api/psd", data="path=something",
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        ).status_code, 415)
        self.assertEqual(self.json_post("/api/psd", {
            "path": "relative.psd"}).status_code, 400)

    def test_explicit_tailnet_proxy_host_origin_and_localhost_backwards_compatible(self):
        import tachie_motion.web.app as web_app

        tailnet = "https://example-node.my-tailnet.ts.net:8443"
        # Import-time middleware allowlist is intentional; recreate it under
        # the opted-in environment, then restore the default immediately.
        try:
            with patch.dict(os.environ, {"TACHIE_TAILSCALE_ORIGIN": tailnet}):
                module = importlib.reload(web_app)
                client = TestClient(module.app, base_url=tailnet)
                payload = {"path": str(self.psd)}
                self.assertEqual(client.get("/api/health").status_code, 200)
                self.assertEqual(
                    client.post("/api/psd", json=payload, headers={"Origin": tailnet}).status_code,
                    200,
                )
                self.assertEqual(
                    client.post("/api/psd", json=payload,
                                headers={"Origin": "https://evil.example.org"}).status_code,
                    403,
                )
                self.assertEqual(
                    client.post("/api/psd", json=payload,
                                headers={"Origin": "http://example-node.my-tailnet.ts.net:8443"}).status_code,
                    403,
                )
                self.assertEqual(
                    client.get("/api/health", headers={"Host": "foreign.ts.net"}).status_code,
                    400,
                )
                self.assertEqual(
                    client.get("/api/health", headers={
                        "Host": "example-node.my-tailnet.ts.net:443"
                    }).status_code, 400,
                )
                self.assertEqual(
                    client.get("/api/health", headers={
                        "Host": "example-node.my-tailnet.ts.net"
                    }).status_code, 400,
                )
                loopback = TestClient(module.app, base_url="http://127.0.0.1:8765")
                self.assertEqual(loopback.post(
                    "/api/psd", json=payload,
                    headers={"Origin": "http://127.0.0.1:8765"},
                ).status_code, 200)
        finally:
            importlib.reload(web_app)

        # The default mode must not silently start trusting the tailnet host.
        client = TestClient(web_app.app, base_url=tailnet)
        self.assertEqual(client.get("/api/health").status_code, 400)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
    def test_export_uses_existing_pipeline_and_does_not_copy_wav(self):
        original = self.psd.read_bytes(), self.wav.read_bytes()
        args = {
            "psd": str(self.psd), "wav": str(self.wav),
            "closed": self.closed, "opened": self.opened,
            "output_dir": str(self.root), "basename": "sample", "fps": 30
        }
        data = self.json_post("/api/export", args)
        self.assertEqual(data.status_code, 200, data.text)
        result = data.json()
        self.assertEqual(result["frames"], 4)
        self.assertEqual(result["sample_count"], 101)
        self.assertTrue(Path(result["mov"]).is_file())
        otio = json.loads(Path(result["otio"]).read_text("utf-8"))
        refs = [
            track["children"][0]["media_references"]["DEFAULT_MEDIA"]["target_url"]
            for track in otio["tracks"]["children"]
        ]
        self.assertEqual(refs[0], Path(result["mov"]).resolve().as_uri())
        self.assertEqual(refs[1], str(Path(result["mov"]).resolve()))
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), original)
        self.assertEqual(
            {path.resolve() for path in self.root.iterdir()},
            {path.resolve() for path in (
                self.psd, self.wav, Path(result["mov"]), Path(result["otio"]),
            )},
        )
        # Repeat must never overwrite prior MOV or OTIO.
        second = self.json_post("/api/export", args)
        self.assertEqual(second.status_code, 400)
        self.assertTrue(Path(result["mov"]).is_file())

    def test_oversized_psd_is_rejected_before_analysis_or_render(self):
        # Do not allocate a 100 MP synthetic image; fake only the PSD header.
        args = {
            "psd": str(self.psd), "wav": str(self.wav),
            "closed": self.closed, "opened": self.opened,
            "output_dir": str(self.root), "basename": "too-large", "fps": 30,
        }
        sources = (self.psd.read_bytes(), self.wav.read_bytes())
        with patch(
            "tachie_motion.web.service.PSDImage.open",
            return_value=SimpleNamespace(width=10_000, height=10_000),
        ) as open_psd, patch(
            "tachie_motion.web.app.export_mouth_animation",
        ) as render, patch(
            "tachie_motion.lipsync.pipeline.analyze_wav",
        ) as analyze:
            response = self.json_post("/api/export", args)
            self.assertEqual(response.status_code, 400, response.text)
            self.assertIn("safety limit", response.json()["detail"])
            open_psd.assert_called_once()
            render.assert_not_called()
            analyze.assert_not_called()
        self.assertEqual(set(self.root.iterdir()), {self.psd, self.wav})
        self.assertEqual((self.psd.read_bytes(), self.wav.read_bytes()), sources)

    def test_export_rejects_output_path_escape_and_invalid_fps(self):
        args = {
            "psd": str(self.psd), "wav": str(self.wav),
            "closed": self.closed, "opened": self.opened,
            "output_dir": str(self.root), "basename": "../escape", "fps": 30,
        }
        self.assertEqual(self.json_post("/api/export", args).status_code, 400)
        args["basename"] = "safe"
        args["fps"] = 29
        self.assertEqual(self.json_post("/api/export", args).status_code, 400)
        self.assertEqual(set(self.root.iterdir()), {self.psd, self.wav})


if __name__ == "__main__":
    unittest.main()
