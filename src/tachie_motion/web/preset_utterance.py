"""One-WAV preset-snapshot export, initial none/open slice.

Never use original PSD visibility in place of the chosen unified preset.
Unsupported animation modes fail explicitly instead of exporting misleading media.
"""

from pathlib import Path
import tempfile

from tachie_motion.animation.blink import (
    schedule_random_blink_frames, compose_mouth_eye_indices,
)
from tachie_motion.audio.volume import analyze_wav
from tachie_motion.web.aiueo_renderer import (
    AIUEO_KEYS, validate_aiueo_mouth, render_aiueo_states, inspect_export_lab,
    verify_export_lab, aiueo_indices, validate_psdtool_state,
)
from tachie_motion.presets import LayerState, LayerStateSet
from tachie_motion.web.eye_renderer import validate_closed_eye, render_blink_states
from tachie_motion.psd.crop import write_fixed_crop_png
from tachie_motion.psd.tree import walk_layers
from tachie_motion.psd.visibility import parse_index_path, resolve_layer
from tachie_motion.render.sequence import encode_prores_sequence
from tachie_motion.render.pcm_mux import mux_verified_pcm
from tachie_motion.timeline.media import MovieTiming, WaveTiming
from tachie_motion.timeline.otio_json import build_rounded_utterance, write_otio
from tachie_motion.web.preset_preview import psd_snapshot_token
from tachie_motion.web.output_destinations import initial_target_identity, publish_pair
from tachie_motion.web.solo_output import initial_single_identity, publish_single
from tachie_motion.web.service import load_psd
from tachie_motion.web.preview_frame import file_identity


def verify_wav_source(path: Path, expected: str) -> None:
    if ':'.join(map(str, file_identity(path))) != expected:
        raise ValueError('WAV changed since registration; nothing was published')


def validated_snapshot(psd_path: Path, fingerprint: str, layers: list[dict]):
    if not isinstance(fingerprint, str) or not fingerprint:
        raise ValueError("PSD fingerprint required")
    if psd_snapshot_token(str(psd_path)) != fingerprint:
        raise ValueError("PSD has changed; reload the presets")
    psd = load_psd(str(psd_path))
    if psd_snapshot_token(str(psd_path)) != fingerprint:
        raise ValueError("PSD changed during load")
    if type(layers) is not list or not 0 < len(layers) <= 50_000:
        raise ValueError("Invalid preset layers")
    states = []
    for item in layers:
        if type(item) is not dict or type(item.get("path")) is not str:
            raise ValueError("Each layer needs a path")
        if type(item.get("visible")) is not bool:
            raise ValueError("Layer visibility must be bool")
        states.append(LayerState(parse_index_path(item["path"]), item["visible"]))
    mapping = LayerStateSet(tuple(states))
    expected = {summary.index_path for summary in walk_layers(psd)}
    if len(mapping.layers) != len(expected) or {s.path for s in mapping.layers} != expected:
        raise ValueError("Preset layers do not match PSD snapshot")
    for item in mapping.layers:
        resolve_layer(psd, item.path).visible = item.visible
    return psd, {item.path: item.visible for item in mapping.layers}


def validate_open_mouth(psd, base: dict, mouth: dict | None,
                        mouth_groups: list[str] | None = None):
    if type(mouth) is not dict or set(mouth) != {"closed", "opened"}:
        raise ValueError("This preset has no complete open mouth definition")
    summaries = tuple(walk_layers(psd))
    validate_psdtool_state(summaries, base, "Open base")
    states = {}
    for key in ("closed", "opened"):
        entries = mouth[key]
        if type(entries) is not list or not 0 < len(entries) <= 50_000:
            raise ValueError("Mouth shape must contain target layers")
        result = {}
        for item in entries:
            if type(item) is not dict or type(item.get("path")) is not str:
                raise ValueError("Mouth target requires an index path")
            if type(item.get("visible")) is not bool:
                raise ValueError("Mouth target visibility must be bool")
            path = parse_index_path(item["path"])
            if path in result or path not in base:
                raise ValueError("Duplicate or unknown mouth layer")
            if resolve_layer(psd, path).is_group():
                raise ValueError("Mouth targets must be leaf layers")
            if any(base.get(path[:i]) is False for i in range(1, len(path))):
                raise ValueError("Mouth layer has a hidden parent; change preset visibility first")
            result[path] = item["visible"]
        states[key] = result
    if states["closed"].keys() != states["opened"].keys():
        raise ValueError("Both mouth shapes must target the same layers")
    # The paired closed map is structural; resting frames always use base.
    if not any(states["opened"].values()):
        raise ValueError("Open mouth has no explicitly selected visible layer")
    if mouth_groups is not None:
        known = {item.index_path: item for item in summaries}
        if (type(mouth_groups) is not list or not mouth_groups or
                any(type(group) is not str for group in mouth_groups)):
            raise ValueError("Invalid Open mouth groups")
        groups = tuple(parse_index_path(group) for group in mouth_groups)
        if len(set(groups)) != len(groups) or any(
                path not in known or known[path].kind != "group" for path in groups):
            raise ValueError("Invalid Open mouth groups")
        hidden = {item.index_path: False for item in summaries
                  if item.kind != "group" and not item.name.startswith("!")
                  and any(item.index_path[:len(group)] == group
                          and len(item.index_path) > len(group) for group in groups)}
        if any(path not in hidden for path in states["opened"]):
            raise ValueError("Open mouth target is outside assigned PSD groups")
        states["opened"] = {**hidden, **states["opened"]}
    validate_psdtool_state(summaries, {**base, **states["opened"]}, "Open opened")
    return states


def export_preset_utterance(
    *, psd_path: Path, wav: Path, fingerprint: str, layers: list[dict],
    mouth: dict | None, mode: str, blink_enabled: bool,
    mov: Path, otio: Path | None, fps: int = 30, conflict_policy: str = "error",
    source_identity: str | None = None, aiueo_mouth: dict | None = None,
    mouth_groups: list[str] | None = None, lab_source_identity: str | None = None,
    eyes: dict | None = None, eye_groups: list[str] | None = None,
    blink_timing: dict | None = None,
    protect_otio_references: bool = False,
):
    """Generate a preset-backed PCM MOV with optional OTIO for callers that need it.

    Supports none/open/aiueo, with fresh blink timing variation per export.
    Timeline change points and multiple character tracks remain excluded.
    """
    if mode not in ("none", "open", "aiueo"):
        raise ValueError("Lip mode is not implemented")
    if type(blink_enabled) is not bool:
        raise ValueError("Blink setting must be a boolean")
    if blink_enabled and (
            type(blink_timing) is not dict or
            set(blink_timing) != {
                "interval_frames", "closed_frames", "jitter_frames",
                "phase_frames", "seed",
            }):
        raise ValueError("Blink requires explicit frame timing and seed")
    if blink_enabled and mode != "none" and (
            type(mouth_groups) is not list or not mouth_groups):
        raise ValueError("Blink with lip motion requires explicit mouth PSD groups")
    if fps not in (24, 30, 60):
        raise ValueError("Unsupported frame rate")
    if mov.suffix.lower() != ".mov" or (otio is not None and otio.suffix.lower() != ".otio"):
        raise ValueError("Expected MOV and OTIO destinations")
    if otio is not None and mov.parent != otio.parent:
        raise ValueError("MOV and OTIO must be in one output directory")
    if source_identity is not None:
        import re
        if not re.fullmatch(r'[0-9]+(:[0-9]+){4}', source_identity):
            raise ValueError('Invalid registered WAV identity')
        verify_wav_source(wav, source_identity)
    prior = (initial_target_identity(mov, otio, conflict_policy)
             if otio is not None else initial_single_identity(
                 mov, conflict_policy,
                 protect_otio_references=protect_otio_references))

    psd, base = validated_snapshot(psd_path, fingerprint, layers)
    closed_eye = (validate_closed_eye(psd, base, eyes, eye_groups, mouth_groups)
                  if blink_enabled else None)
    shapes = validate_open_mouth(psd, base, mouth, mouth_groups) if mode == "open" else None
    six = (validate_aiueo_mouth(psd, base, aiueo_mouth, mouth_groups)
           if mode == "aiueo" else None)
    schedule = analyze_wav(wav, fps=fps)
    if source_identity is not None:
        verify_wav_source(wav, source_identity)
    if six is not None:
        if source_identity is None:
            raise ValueError("aiueo requires registered WAV identity")
        import re
        if (type(lab_source_identity) is not str
                or re.fullmatch(r"[0-9]+(:[0-9]+){4}", lab_source_identity) is None):
            raise ValueError("aiueo requires verified LAB source identity")
        intervals, lab_identity = inspect_export_lab(wav, source_identity)
        if ":".join(map(str, lab_identity)) != lab_source_identity:
            raise ValueError("LAB changed since selection; nothing was published")
        indices = aiueo_indices(
            intervals, samples=schedule.sample_count,
            sample_rate=schedule.sample_rate, fps=fps,
        )
    else:
        intervals, lab_identity = None, None
        indices = tuple(1 if shapes and frame.mouth == "open" else 0
                        for frame in schedule.frames)
    if len(indices) != len(schedule.frames):
        raise ValueError("LAB video frame count disagrees with WAV timing")
    if closed_eye is not None:
        blink_frames = schedule_random_blink_frames(
            frame_count=len(indices), **blink_timing,
        )
    work = tempfile.TemporaryDirectory(prefix=".tachie-preset-", dir=mov.parent)
    committed = False
    cleanup_warning = None
    try:
        directory = Path(work.name)
        if closed_eye is not None:
            mouth_poses = (tuple(six[key] for key in AIUEO_KEYS) if six is not None
                           else ({}, shapes["opened"]) if shapes is not None
                           else ({},))
            pngs = render_blink_states(psd, base, closed_eye, mouth_poses, directory)
            indices = compose_mouth_eye_indices(
                indices, blink_frames, mouth_pose_count=len(mouth_poses),
            )
        elif six is not None:
            pngs = render_aiueo_states(psd, base, six, directory)
        else:
            pngs = []
            for state in (("closed", "opened") if shapes else ("base",)):
                # Each frame starts from the preset's current fixed visibility.
                # Paired closed data never overrides the fixed resting pose.
                for path, visible in base.items():
                    resolve_layer(psd, path).visible = visible
                if shapes and state == "opened":
                    for path, visible in shapes["opened"].items():
                        resolve_layer(psd, path).visible = visible
                png = directory / (state + ".png")
                write_fixed_crop_png(psd, png, padding=16)
                pngs.append(png)
        if psd_snapshot_token(str(psd_path)) != fingerprint:
            raise ValueError("PSD changed during rendering; nothing was published")
        staged_mov = directory / "staged.mov"
        report = encode_prores_sequence(pngs, indices, staged_mov, fps=fps)
        if report.frames != len(indices) or report.decoded_frames != len(indices):
            raise RuntimeError("Encoded MOV frame count mismatch")
        if psd_snapshot_token(str(psd_path)) != fingerprint:
            raise ValueError("PSD changed during export; nothing was published")
        # Reuse the already-verified compressed video packets. The mux is
        # separately checked for identical video packets and decoded PCM.
        pcm_mov = directory / "pcm.mov"
        mux_verified_pcm(
            staged_mov, wav, pcm_mov,
            expected_samples=schedule.sample_count,
            expected_sample_rate=schedule.sample_rate,
            expected_channels=schedule.channels,
            expected_sample_width_bits=schedule.sample_width_bits,
            expected_pcm_sha256=schedule.pcm_sha256,
        )
        if source_identity is not None:
            # Nothing may reach the public output names after the WAV changes.
            verify_wav_source(wav, source_identity)
        if intervals is not None:
            verify_export_lab(wav, source_identity, intervals, lab_identity)
        if otio is not None:
            # Optional internal pair writer; the production individual route passes otio=None.
            document = build_rounded_utterance(
                pcm_mov, wav, MovieTiming(report.frames, fps),
                WaveTiming(schedule.sample_count, schedule.sample_rate),
                embedded_audio=True,
            )
            video_ref = document["tracks"]["children"][0]["children"][0][
                "media_references"]["DEFAULT_MEDIA"]
            video_ref["target_url"] = mov.as_uri()
            video_ref["name"] = mov.name
            audio_ref = document["tracks"]["children"][1]["children"][0][
                "media_references"]["DEFAULT_MEDIA"]
            audio_ref["target_url"] = str(mov.absolute())
            audio_ref["name"] = mov.name
            staged_otio = directory / "staged.otio"
            write_otio(document, staged_otio)
            if source_identity is not None:
                verify_wav_source(wav, source_identity)
            if intervals is not None:
                verify_export_lab(wav, source_identity, intervals, lab_identity)
            warning = publish_pair(
                pcm_mov, staged_otio, mov, otio,
                policy=conflict_policy, prior=prior,
            )
        else:
            # Solo route publishes only its MOV; batch follows with one shared OTIO.
            if intervals is not None:
                verify_export_lab(wav, source_identity, intervals, lab_identity)
            warning = publish_single(
                pcm_mov, mov, policy=conflict_policy, prior=prior,
                protect_otio_references=protect_otio_references,
            )
        committed = True
    finally:
        try:
            work.cleanup()
        except OSError:
            if not committed:
                raise
            cleanup_warning = (
                ("MOV and OTIO were" if otio is not None else "MOV was")
                + " saved, but temporary render files could not "
                "be fully removed: " + work.name
            )
    result = {"mov": str(mov), "frames": report.frames,
              "sample_count": schedule.sample_count, "sample_rate": schedule.sample_rate}
    if otio is not None:
        result["otio"] = str(otio)
    warnings = [message for message in (warning, cleanup_warning) if message]
    if warnings:
        result["warning"] = " ".join(warnings)
    return result
