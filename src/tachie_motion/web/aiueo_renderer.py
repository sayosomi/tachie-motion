"""Validate six mouth shapes and guard the LAB used to render them.

The PSD and WAV/LAB remain read-only. Per-pose visibility always starts
from the same registered preset base, never from the previous pose.
"""

import os
from pathlib import Path
import stat

from tachie_motion.audio.aiueo_frames import MOV_POLICY, schedule_aiueo
from tachie_motion.audio.lab import inspect_adjacent_lab
from tachie_motion.psd.crop import write_fixed_crop_png
from tachie_motion.psd.tree import walk_layers
from tachie_motion.psd.visibility import parse_index_path, resolve_layer


AIUEO_KEYS = ("a", "i", "u", "e", "o", "n")


def _identity(info):
    return info.st_dev, info.st_ino, info.st_ctime_ns, info.st_size, info.st_mtime_ns


def inspect_export_lab(wav: Path, source_identity: str):
    """Inspect strict sibling LAB against registered WAV without path normalization."""
    lab = wav.with_suffix(".lab")
    try:
        before = os.lstat(lab)
    except FileNotFoundError as exc:
        raise ValueError("aiueo requires a valid sibling LAB; none was found") from exc
    if not stat.S_ISREG(before.st_mode):
        raise ValueError("aiueo LAB must be a regular file, not a link")
    expected_wav = tuple(int(field) for field in source_identity.split(":"))
    inspection = inspect_adjacent_lab(wav, expected_wav_identity=expected_wav)
    if inspection.status != "valid":
        raise ValueError("aiueo requires a valid sibling LAB: " +
                         (inspection.reason or inspection.status))
    if _identity(os.lstat(lab)) != _identity(before):
        raise ValueError("LAB changed during inspection; nothing was published")
    return inspection.intervals, _identity(before)


def verify_export_lab(wav: Path, source_identity: str,
                      original_intervals: tuple, original_identity: tuple) -> None:
    try:
        intervals, identity = inspect_export_lab(wav, source_identity)
    except (OSError, ValueError) as exc:
        raise ValueError("LAB changed during rendering; nothing was published") from exc
    if intervals != original_intervals or identity != original_identity:
        raise ValueError("LAB changed during rendering; nothing was published")


def validate_aiueo_mouth(psd, base: dict, mouth: dict | None,
                         mouth_groups: list[str] | None = None) -> dict:
    """Require all six explicit mouth shapes, including rest ('n').

    All six named entries must exist and remain subject to PSD visibility rules.
    """
    if type(mouth) is not dict or set(mouth) != set(AIUEO_KEYS):
        raise ValueError("This preset has no complete six-shape aiueo mouth")
    summaries = tuple(walk_layers(psd))
    source = {item.index_path: item for item in summaries}
    if mouth_groups is not None:
        if (type(mouth_groups) is not list or len(mouth_groups) > len(source)
                or any(type(group) is not str for group in mouth_groups)):
            raise ValueError("Invalid aiueo target PSD groups")
        groups = tuple(parse_index_path(group) for group in mouth_groups)
        if len(set(groups)) != len(groups) or any(
                path not in source or source[path].kind != "group" for path in groups):
            raise ValueError("Unknown aiueo target PSD group")
    else:
        groups = tuple(item.index_path for item in summaries if item.kind == "group")
    if not groups:
        raise ValueError("aiueo requires assigned PSD mouth groups")
    siblings: dict[tuple[int, ...], list[tuple[int, ...]]] = {}
    fixed: list[tuple[int, ...]] = []
    for item in summaries:
        if item.name.startswith("*"):
            siblings.setdefault(item.index_path[:-1], []).append(item.index_path)
        elif item.name.startswith("!"):
            fixed.append(item.index_path)
    results = {}
    for key in AIUEO_KEYS:
        entries = mouth[key]
        if (type(entries) is not list or len(entries) > 50_000
                or not any(type(entry) is dict and entry.get("visible") is True for entry in entries)):
            raise ValueError("aiueo mouth " + key + " is not configured")
        overrides = {}
        for entry in entries:
            if (type(entry) is not dict or set(entry) != {"path", "visible"}
                    or type(entry["path"]) is not str or type(entry["visible"]) is not bool):
                raise ValueError("Malformed aiueo mouth target")
            path = parse_index_path(entry["path"])
            if path in overrides or path not in base or path not in source:
                raise ValueError("Duplicate or unknown aiueo mouth target")
            if resolve_layer(psd, path).is_group():
                raise ValueError("aiueo mouth must target PSD leaf layers")
            if not any(path[:len(group)] == group and len(path) > len(group)
                       for group in groups):
                raise ValueError("aiueo mouth target is outside its assigned PSD groups")
            if any(base.get(path[:i]) is False for i in range(1, len(path))):
                raise ValueError("aiueo mouth has a hidden parent; adjust preset visibility")
            overrides[path] = entry["visible"]
        effective = {**base, **overrides}
        if any(effective.get(path) is not True for path in fixed):
            raise ValueError("aiueo mouth violates ! mandatory PSD layer")
        for paths in siblings.values():
            if sum(effective.get(path) is True for path in paths) > 1:
                raise ValueError("aiueo mouth violates * exclusive PSD layer")
        results[key] = overrides
    return results


def render_aiueo_states(psd, base: dict, mouth: dict, directory: Path) -> list[Path]:
    """Generate six PNGs with invariant fixed crop and explicit base restoration."""
    paths: list[Path] = []
    for key in AIUEO_KEYS:
        for path, visible in base.items():
            resolve_layer(psd, path).visible = visible
        for path, visible in mouth[key].items():
            resolve_layer(psd, path).visible = visible
        png = directory / ("aiueo-" + key + ".png")
        write_fixed_crop_png(psd, png, padding=16)
        paths.append(png)
    return paths


def aiueo_indices(intervals: tuple, *, samples: int, sample_rate: int,
                  fps: int) -> tuple[int, ...]:
    shapes = schedule_aiueo(
        intervals, samples=samples, sample_rate=sample_rate, fps=fps, policy=MOV_POLICY,
    )
    return tuple(AIUEO_KEYS.index(shape) for shape in shapes)
