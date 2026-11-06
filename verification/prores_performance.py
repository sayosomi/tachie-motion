"""Reproducible Phase 0 1654x2030 / 30-frame performance benchmark.

Run: python -m verification.prores_performance

The benchmark distinguishes actual ProRes encoding from independent MOV
verification. "F-10 disabled" is a benchmark-only monkeypatch of the 32px
area-mean gate; it is NEVER an application option. The severe 8px check and
the rest of the validator stay enabled in all scenarios.

Use synthetic RGBA stills (not private PSD), ffmpeg/prores_ks at the real
project's settings. Also evaluate a frame-wide subthreshold delta. The
pre-optimization F-10 reference is copied solely for comparative timing,
never used in production.
"""

from contextlib import contextmanager
from pathlib import Path
import argparse
import json
import os
import statistics
import subprocess
import tempfile
from time import perf_counter
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFilter
from tachie_motion.render import block_integrity
from tachie_motion.render.probe import inspect_prores
from tachie_motion.render.prores import ffmpeg_args, read_rgba_states


def previous_area_mean(error: Image.Image, tile_size=32, *, threshold=18):
    """Exact pre-optimization a46d676 reference for timing only."""
    if tile_size != 32:
        raise ValueError("Area window size must be 32")
    if threshold < 0 or error.mode != "L":
        raise ValueError("Invalid area scan input")
    if error.getbbox() is None:
        return 0.0
    width, height = error.size
    cutoff = max(1, int(threshold * 1024 / 1089) - 2)
    coarse = error.filter(ImageFilter.BoxBlur(16))
    if coarse.getextrema()[1] < cutoff:
        return 0.0
    candidates = coarse.point(lambda value: 255 if value >= cutoff else 0)
    bounds = candidates.getbbox()
    if bounds is None:
        return 0.0
    x0, y0 = max(0, bounds[0]-tile_size), max(0, bounds[1]-tile_size)
    x1, y1 = min(width, bounds[2]+tile_size), min(height, bounds[3]+tile_size)
    roi = error.crop((x0, y0, x1, y1))
    w, h = roi.size
    if w < tile_size or h < tile_size:
        expanded = Image.new("L", (max(w, tile_size), max(h, tile_size)))
        expanded.paste(roi, (0, 0))
        roi, (w, h) = expanded, expanded.size
    pixels = roi.tobytes()
    columns = [0] * w
    for y in range(tile_size):
        start = y * w
        for x, value in enumerate(pixels[start:start+w]):
            columns[x] += value
    limit, best = threshold * tile_size * tile_size, 0
    for y in range(h-tile_size+1):
        value = sum(columns[:tile_size])
        for x in range(w-tile_size+1):
            if value > best:
                best = value
                if best > limit:
                    return best / (tile_size*tile_size)
            if x+tile_size < w:
                value += columns[x+tile_size] - columns[x]
        if y+tile_size < h:
            old, new = y*w, (y+tile_size)*w
            for x in range(w):
                columns[x] += pixels[new+x] - pixels[old+x]
    return 0.0


@contextmanager
def area_gate(mode: str):
    if mode == "disabled":
        with patch.object(block_integrity, "_max_area_mean", return_value=0.0):
            yield
    elif mode == "previous":
        with patch.object(
            block_integrity, "_max_area_mean", side_effect=previous_area_mean
        ):
            yield
    elif mode == "optimized":
        yield
    else:
        raise ValueError(mode)


def synthetic_states(folder: Path):
    paths = []
    for i in range(2):
        image = Image.new("RGBA", (1654, 2030), (0, 0, 0, 0))
        pen = ImageDraw.Draw(image)
        pen.rounded_rectangle(
            (130, 125, 1510, 1870), radius=230,
            fill=(120, 150, 170, 255),
        )
        pen.rectangle(
            (665, 1100, 735, 1140),
            fill=(255, 0, 0, 255) if not i else (0, 0, 255, 255),
        )
        path = folder / f"state-{i}.png"
        image.save(path)
        paths.append(path)
    return paths


def encode_only(states, out, *, fps=30, frames_per_state=15):
    dimensions, images = read_rgba_states(states)
    args = ffmpeg_args(
        ffmpeg="ffmpeg", dimensions=dimensions, fps=fps,
        frame_count=len(images)*frames_per_state, output=out,
    )
    start = perf_counter()
    p = subprocess.Popen(
        args, stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    assert p.stdin is not None
    for image in images:
        for _ in range(frames_per_state):
            p.stdin.write(image)
    p.stdin.close()
    p.stdin = None
    _, err = p.communicate()
    if p.returncode:
        raise RuntimeError(err.decode("utf-8", "replace")[-2000:])
    return perf_counter()-start, dimensions, images


def verify_only(video, dimensions, images, *, mode: str):
    start = perf_counter()
    with area_gate(mode):
        report = inspect_prores(
            video, expected_size=dimensions, expected_frames=30,
            expected_fps=30, source_states=images, frames_per_state=15,
        )
    elapsed = perf_counter()-start
    if report.decoded_frames != 30:
        raise AssertionError("Did not verify 30/30 decoded frames")
    return elapsed


def broad_subthreshold(frames: int, mode: str):
    # +16 RGB and -16 alpha across a full opaque frame. No individual
    # channel exceeds the F-10 mean tolerance 18; F-08's >48/>96 severe
    # pixel gates cannot catch these by construction.
    expected = Image.new("RGBA", (1654, 2030), (80, 100, 120, 255))
    actual = Image.new("RGBA", (1654, 2030), (96, 116, 136, 239))
    start = perf_counter()
    with area_gate(mode):
        for i in range(frames):
            peaks = block_integrity.check_frame_blocks(
                actual, expected, frame_index=i
            )
            if peaks != (0, 0):
                raise AssertionError(f"False positive on frame {i}: {peaks}")
    return perf_counter()-start


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stress-frames", type=int, default=30)
    parser.add_argument("--rounds", type=int, default=2)
    options = parser.parse_args()
    if options.stress_frames <= 0 or options.rounds <= 0:
        parser.error("Frame and round counts must be positive")
    print(json.dumps({
        "benchmark": "synthetic transparent ProRes",
        "dimensions": "1654x2030", "fps": 30, "frames": 30,
        "stress_frames": options.stress_frames,
        "ffmpeg": subprocess.check_output(["ffmpeg", "-version"]).decode().splitlines()[0],
        "platform": os.uname().sysname if hasattr(os, "uname") else os.name,
    }), flush=True)
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        states = synthetic_states(root)
        results = []
        for i in range(options.rounds):
            mov = root / f"encoded-{i}.mov"
            encode_s, dims, images = encode_only(states, mov)
            verify = {}
            # Alternate order across rounds to reduce warm-cache bias.
            modes = ("disabled", "previous", "optimized")
            if i % 2:
                modes = tuple(reversed(modes))
            for mode in modes:
                verify[mode] = verify_only(mov, dims, images, mode=mode)
            results.append({"encode_s": encode_s, "verify_s": verify})
            print(json.dumps({"round": i+1, **results[-1]}), flush=True)
        summary = {
            "encode_s": statistics.median(r["encode_s"] for r in results),
            "verify_s": {
                mode: statistics.median(r["verify_s"][mode] for r in results)
                for mode in ("disabled", "previous", "optimized")
            },
        }
        summary["total_s"] = {
            mode: summary["encode_s"] + summary["verify_s"][mode]
            for mode in ("disabled", "previous", "optimized")
        }
        summary["f10_overhead_pct"] = 100 * (
            summary["total_s"]["optimized"]/summary["total_s"]["disabled"]-1
        )
        summary["f10_previous_overhead_pct"] = 100 * (
            summary["total_s"]["previous"]/summary["total_s"]["disabled"]-1
        )
        print(json.dumps({"median": summary}), flush=True)

    stress = {}
    for mode in ("disabled", "previous", "optimized"):
        stress[mode] = broad_subthreshold(options.stress_frames, mode)
        print(json.dumps({
            "stress": "RGBA wide +/-16 (<F10 MAE=18)", "mode": mode,
            "frames": options.stress_frames, "seconds": stress[mode],
        }), flush=True)
    print(json.dumps({"status": "PASS", "note": "Mac/PSD timing requires human run"}))


if __name__ == "__main__":
    main()
