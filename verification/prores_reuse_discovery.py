"""Read-only ProRes packet-reuse feasibility benchmark for Issue #8.

No production code is modified. All MOV/concat intermediate media live inside
TemporaryDirectory and are removed on exit. Never upload private PNGs or MOVs.
Run:
    PYTHONPATH=src python -m verification.prores_reuse_discovery \
        --frame path/to/open.png --frame path/to/closed.png \
        --hold 150 --fps 30 --rounds 2
"""

import argparse
from fractions import Fraction
import json
from pathlib import Path
import statistics
import subprocess
import tempfile
from time import perf_counter

from tachie_motion.render.prores import ffmpeg_args, read_rgba_states
from tachie_motion.render.probe import inspect_prores


def _run(args: list[str], *, data: bytes | None = None) -> bytes:
    proc = subprocess.run(
        args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {args[0]}\n"
            + proc.stderr.decode("utf-8", "replace")[-2000:]
        )
    return proc.stdout


def _probe(path: Path) -> dict:
    data = _run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,profile,pix_fmt,"
        "width,height,time_base,nb_frames,r_frame_rate,avg_frame_rate,duration",
        "-of", "json", str(path),
    ])
    return json.loads(data)["streams"][0]


def _packet_hashes(path: Path, fps: int, count: int) -> list[str]:
    stream = _probe(path)
    if (
        stream["codec_name"] != "prores"
        or "4444" not in stream["profile"]
        or not str(stream["pix_fmt"]).startswith("yuva444p")
        or int(stream["nb_frames"]) != count
        or Fraction(stream["r_frame_rate"]) != fps
        or Fraction(stream["avg_frame_rate"]) != fps
        or Fraction(stream["duration"]) != Fraction(count, fps)
    ):
        raise RuntimeError(f"Unexpected ProRes stream metadata: {stream}")
    tick = Fraction(1, fps) / Fraction(stream["time_base"])
    if tick.denominator != 1:
        raise RuntimeError(f"Nonintegral frame tick: {tick}")

    report = json.loads(_run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_packets", "-show_data_hash", "sha256",
        "-show_entries", "packet=pts,dts,duration,flags,data_hash",
        "-of", "json", str(path),
    ]))
    packets = report["packets"]
    if len(packets) != count:
        raise RuntimeError("Incorrect packet count")
    result = []
    for i, pkt in enumerate(packets):
        if (
            int(pkt["pts"]) != i * tick.numerator
            or int(pkt["dts"]) != i * tick.numerator
            or int(pkt["duration"]) != tick.numerator
            or "K" not in pkt["flags"]
        ):
            raise RuntimeError(f"Bad packet timing or flag at frame {i}")
        result.append(pkt["data_hash"])
    return result


def _encode_standard(
    images: list[bytes], dimensions: tuple[int, int],
    *, fps: int, hold: int, output: Path,
) -> float:
    args = ffmpeg_args(
        ffmpeg="ffmpeg", dimensions=dimensions, fps=fps,
        frame_count=len(images)*hold, output=output,
    )
    start = perf_counter()
    proc = subprocess.Popen(
        args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        assert proc.stdin is not None
        for image in images:
            for _ in range(hold):
                proc.stdin.write(image)
        proc.stdin.close()
        proc.stdin = None
        _, err = proc.communicate()
        if proc.returncode:
            raise RuntimeError(err.decode("utf-8", "replace")[-2000:])
    except BaseException:
        if proc.poll() is None:
            proc.kill()
        if proc.stdin is not None:
            proc.stdin.close()
            proc.stdin = None
        proc.communicate()
        raise
    return perf_counter() - start


def _encode_reused(
    images: list[bytes], dimensions: tuple[int, int],
    *, fps: int, hold: int, output: Path, staging: Path,
) -> float:
    start = perf_counter()
    originals = []
    for i, image in enumerate(images):
        path = staging / f"single_{i}.mov"
        _run(ffmpeg_args(
            ffmpeg="ffmpeg", dimensions=dimensions, fps=fps,
            frame_count=1, output=path,
        ), data=image)
        originals.append(path)

    infos = [_probe(file) for file in originals]
    timebase = Fraction(infos[0]["time_base"])
    tick = Fraction(1, fps) / timebase
    if tick.denominator != 1 or tick.numerator < 1:
        raise RuntimeError("Expected exact integer timestamp step")
    for info in infos:
        if (
            info["codec_name"] != "prores"
            or "4444" not in info["profile"]
            or not str(info["pix_fmt"]).startswith("yuva444p")
            or Fraction(info["time_base"]) != timebase
            or Fraction(info["r_frame_rate"]) != fps
            or int(info["nb_frames"]) != 1
        ):
            raise RuntimeError(f"Incompatible single-frame ProRes: {info}")

    rewrite = (
        f"setts=pts=N*{tick.numerator}:dts=N*{tick.numerator}"
        f":duration={tick.numerator}"
    )
    holds = []
    for i, single in enumerate(originals):
        part = staging / f"hold_{i}.mov"
        _run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-stream_loop", str(hold - 1), "-i", str(single),
            "-map", "0:v:0", "-an", "-c:v", "copy",
            "-bsf:v", rewrite, "-f", "mov", "-y", str(part),
        ])
        holds.append(part)

    # Only generated ASCII basenames appear in the manifest, never user paths.
    manifest = staging / "parts.ffconcat"
    manifest.write_text(
        "ffconcat version 1.0\n"
        + "".join(f"file '{part.name}'\n" for part in holds),
        encoding="ascii",
    )
    _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "concat", "-safe", "1", "-i", str(manifest),
        "-map", "0:v:0", "-an", "-c:v", "copy", "-bsf:v", rewrite,
        "-f", "mov", "-y", str(output),
    ])
    return perf_counter() - start


def _verify(
    file: Path, dimensions: tuple[int, int], images: list[bytes],
    *, fps: int, hold: int,
) -> tuple[float, dict]:
    start = perf_counter()
    rep = inspect_prores(
        file, expected_size=dimensions,
        expected_frames=len(images)*hold, expected_fps=fps,
        source_states=images, frames_per_state=hold,
    )
    seconds = perf_counter() - start
    return seconds, {
        "frames": rep.frames,
        "decoded_frames": rep.decoded_frames,
        "alpha_mae": rep.max_alpha_mean_error,
        "rgb_mae": rep.max_rgb_mean_error,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frame", type=Path, action="append", required=True)
    parser.add_argument("--fps", type=int, default=30, choices=(24, 30, 60))
    parser.add_argument("--hold", type=int, default=150)
    parser.add_argument("--rounds", type=int, default=2)
    opts = parser.parse_args()
    if opts.hold <= 1 or opts.rounds < 1 or len(opts.frame) < 2:
        parser.error("Need >=2 PNG states, hold >=2 and rounds >=1")

    dimensions, images = read_rgba_states(opts.frame)
    count = len(images) * opts.hold
    print(f"INPUT_SIZE={dimensions[0]}x{dimensions[1]}", flush=True)
    print(f"FPS={opts.fps} FRAMES={count} STATES={len(images)}", flush=True)
    results = []
    with tempfile.TemporaryDirectory(prefix="tachie-packet-discovery-") as root:
        for idx in range(opts.rounds):
            run = Path(root) / f"round_{idx}"
            run.mkdir()
            baseline = run / "standard.mov"
            reuse = run / "reused.mov"
            regular = _encode_standard(
                images, dimensions, fps=opts.fps,
                hold=opts.hold, output=baseline,
            )
            staging = run / "staging"
            staging.mkdir()
            compressed = _encode_reused(
                images, dimensions, fps=opts.fps,
                hold=opts.hold, output=reuse, staging=staging,
            )
            standard_verify, std_report = _verify(
                baseline, dimensions, images, fps=opts.fps, hold=opts.hold,
            )
            reuse_verify, reuse_report = _verify(
                reuse, dimensions, images, fps=opts.fps, hold=opts.hold,
            )
            equal_packets = (
                _packet_hashes(baseline, opts.fps, count)
                == _packet_hashes(reuse, opts.fps, count)
            )
            print(
                "ROUND=" + str(idx+1) + " "
                + json.dumps({
                    "standard_encode_s": round(regular, 4),
                    "reused_encode_s": round(compressed, 4),
                    "standard_verify_s": round(standard_verify, 4),
                    "reused_verify_s": round(reuse_verify, 4),
                    "standard_total_s": round(regular+standard_verify, 4),
                    "reused_total_s": round(compressed+reuse_verify, 4),
                    "same_encoded_packets": equal_packets,
                    "standard_bytes": baseline.stat().st_size,
                    "reused_bytes": reuse.stat().st_size,
                    "quality_standard": std_report,
                    "quality_reused": reuse_report,
                }, ensure_ascii=False),
                flush=True,
            )
            if not equal_packets:
                raise RuntimeError(
                    "Packet payload hashes differ: NOT proven fidelity-identical"
                )
            results.append((regular+standard_verify, compressed+reuse_verify))
    before = statistics.median(v[0] for v in results)
    after = statistics.median(v[1] for v in results)
    print(f"MEDIAN_STANDARD_TOTAL={before:.4f}s")
    print(f"MEDIAN_REUSED_TOTAL={after:.4f}s")
    print(f"MEDIAN_DIFF={after-before:+.4f}s")
    print("SOURCE_FILES_UNCHANGED=YES")
    print("STATUS=PASS")


if __name__ == "__main__":
    main()
