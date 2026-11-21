"""Compose multiple preset snapshots on a single fixed-crop WAV frame schedule.

Each state is rendered from a validated full PSD visibility map, not inherited
from its predecessor. Audio, ProRes verification and publication are handled by
the existing one-utterance writer.
"""

import json
from pathlib import Path
from collections.abc import Callable

from tachie_motion.animation.blink import schedule_random_blink_frames
from tachie_motion.psd.crop import write_fixed_crop_png
from tachie_motion.psd.tree import walk_layers
from tachie_motion.psd.visibility import parse_index_path, resolve_layer
from tachie_motion.presets import LayerState, LayerStateSet
from tachie_motion.web.aiueo_renderer import (
    AIUEO_KEYS, validate_aiueo_mouth, render_aiueo_states, validate_psdtool_state,
)
from tachie_motion.web.eye_renderer import validate_closed_eye, render_blink_states
from tachie_motion.web.preset_timeline import segments_by_frame


def _validated_base(psd, layers: list[dict]) -> dict:
    """Apply a complete checked snapshot, resetting all visibility before poses."""
    if type(layers) is not list or not 0 < len(layers) <= 50_000:
        raise ValueError("Invalid timeline preset layers")
    states = []
    for entry in layers:
        if (type(entry) is not dict or set(entry) != {"path", "visible"}
                or type(entry["path"]) is not str or type(entry["visible"]) is not bool):
            raise ValueError("Malformed timeline preset visibility")
        states.append(LayerState(parse_index_path(entry["path"]), entry["visible"]))
    mapping = LayerStateSet(tuple(states))
    expected = {summary.index_path for summary in walk_layers(psd)}
    if len(mapping.layers) != len(expected) or {layer.path for layer in mapping.layers} != expected:
        raise ValueError("Timeline preset does not cover PSD snapshot")
    for entry in mapping.layers:
        resolve_layer(psd, entry.path).visible = entry.visible
    return {entry.path: entry.visible for entry in mapping.layers}


def render_timeline_states(
    psd, first: dict, changes: tuple[dict, ...], *,
    schedule, fps: int, mouth_groups: list[str] | None,
    eye_groups: list[str] | None, lab_indices: tuple[int, ...] | None,
    directory: Path, check_cancel: Callable[[], None],
    validate_open_mouth: Callable,
) -> tuple[list[Path], tuple[int, ...]]:
    """Render all unique preset states and schedule frame indices across changes."""
    segments = [first, *changes]
    required_blink_keys = {
        "interval_frames", "closed_frames", "jitter_frames",
        "phase_frames", "seed",
    }
    common_blink = None
    for config in segments:
        if config["blink_enabled"]:
            timing = config["blink_timing"]
            if (type(timing) is not dict or set(timing) != required_blink_keys
                    or any(type(v) is not int for v in timing.values())):
                raise ValueError("Blink requires explicit frame timing and seed")
            if common_blink is None:
                common_blink = timing
            elif timing != common_blink:
                raise ValueError("Blink timing must be character-wide for one WAV")
    blink_frames = (schedule_random_blink_frames(
        frame_count=len(schedule.frames), **common_blink)
        if common_blink is not None else (False,) * len(schedule.frames))
    segment_frames = segments_by_frame(
        changes, samples=schedule.sample_count,
        sample_rate=schedule.sample_rate, fps=fps,
        frame_count=len(schedule.frames),
    )
    pngs: list[Path] = []
    descriptors: list[tuple[int, str, bool]] = []
    cache: dict[str, tuple[int, str, bool]] = {}
    for number, config in enumerate(segments):
        check_cancel()
        signature = json.dumps({key: config[key] for key in (
            "layers", "mouth", "aiueo_mouth", "mode", "blink_enabled",
            "eyes", "blink_timing")}, sort_keys=True, allow_nan=False)
        if signature in cache:
            descriptors.append(cache[signature])
            continue
        if len(cache) >= 64:
            raise ValueError("Too many distinct preset pose configurations")
        base = _validated_base(psd, config["layers"])
        mode = config["mode"]
        if mode not in ("none", "open", "aiueo"):
            raise ValueError("Invalid timeline lip mode")
        closed_eye = (validate_closed_eye(
            psd, base, config["eyes"], eye_groups, mouth_groups)
            if config["blink_enabled"] else None)
        if closed_eye is not None and mode != "none" and not mouth_groups:
            raise ValueError("Blink with lip motion requires mouth PSD groups")
        shapes = (validate_open_mouth(psd, base, config["mouth"], mouth_groups)
                  if mode == "open" else None)
        six = (validate_aiueo_mouth(psd, base, config["aiueo_mouth"], mouth_groups)
               if mode == "aiueo" else None)
        if six is not None and lab_indices is None:
            raise ValueError("Timeline aiueo requires verified LAB")
        # The sequence encoder retains one decoded RGBA copy of each pose.
        # Bound even an adversarial timeline before allocating more pose PNGs.
        mouth_pose_count = 6 if six is not None else 2 if shapes is not None else 1
        pose_count = mouth_pose_count * (2 if closed_eye is not None else 1)
        if (len(pngs) + pose_count) * psd.width * psd.height * 4 > 512 * 1024 * 1024:
            raise ValueError("Timeline pose images exceed the 512 MiB RGBA safety budget")
        pose_dir = directory / f"preset-{number}"
        pose_dir.mkdir(parents=True, exist_ok=False)
        if closed_eye is not None:
            mouth_poses = (tuple(six[key] for key in AIUEO_KEYS) if six is not None
                           else ({}, shapes["opened"]) if shapes is not None
                           else ({},))
            states = render_blink_states(psd, base, closed_eye, mouth_poses, pose_dir)
        elif six is not None:
            states = render_aiueo_states(psd, base, six, pose_dir)
        else:
            states = []
            for name in (("closed", "opened") if shapes else ("base",)):
                check_cancel()
                pose = dict(base)
                if shapes and name == "opened":
                    pose.update(shapes["opened"])
                validate_psdtool_state(tuple(walk_layers(psd)), pose, "timeline pose")
                for layer, visible in pose.items():
                    resolve_layer(psd, layer).visible = visible
                image = pose_dir / (name + ".png")
                write_fixed_crop_png(psd, image, padding=16)
                states.append(image)
        descriptor = (len(pngs), mode, closed_eye is not None)
        cache[signature] = descriptor
        descriptors.append(descriptor)
        pngs.extend(states)
    indices = []
    for frame, segment in enumerate(segment_frames):
        offset, mode, blinking = descriptors[segment]
        if mode == "aiueo":
            assert lab_indices is not None
            mouth = lab_indices[frame]
        elif mode == "open":
            mouth = int(schedule.frames[frame].mouth == "open")
        else:
            mouth = 0
        indices.append(offset + 2 * mouth + int(blink_frames[frame])
                       if blinking else offset + mouth)
    return pngs, tuple(indices)
