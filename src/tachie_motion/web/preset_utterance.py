"""One-WAV preset-snapshot export, initial none/open slice.

Never use original PSD visibility in place of the chosen unified preset.
Unsupported modes/blinking fail explicitly instead of exporting misleading media.
"""

from pathlib import Path
import tempfile

from tachie_motion.audio.volume import analyze_wav
from tachie_motion.presets import LayerState, LayerStateSet
from tachie_motion.psd.crop import write_fixed_crop_png
from tachie_motion.psd.tree import walk_layers
from tachie_motion.psd.visibility import parse_index_path, resolve_layer
from tachie_motion.render.sequence import encode_prores_sequence
from tachie_motion.timeline.media import MovieTiming, WaveTiming
from tachie_motion.timeline.otio_json import build_rounded_utterance, write_otio
from tachie_motion.web.preset_preview import psd_snapshot_token
from tachie_motion.web.output_destinations import initial_target_identity, publish_pair
from tachie_motion.web.service import load_psd


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


def validate_open_mouth(psd, base: dict, mouth: dict | None):
    if type(mouth) is not dict or set(mouth) != {"closed", "opened"}:
        raise ValueError("This preset has no complete open mouth definition")
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
    if states["closed"] == states["opened"]:
        raise ValueError("Closed and opened mouth shapes are identical")
    return states


def export_preset_utterance(
    *, psd_path: Path, wav: Path, fingerprint: str, layers: list[dict],
    mouth: dict | None, mode: str, blink_enabled: bool,
    mov: Path, otio: Path, fps: int = 30, conflict_policy: str = "error",
):
    """Generate one preset-backed MOV and WAV-referencing OTIO.

    This slice supports none/open only. aiueo, blink, timeline change points,
    and multiple character tracks are explicitly excluded until implemented.
    """
    if mode not in ("none", "open"):
        raise ValueError("Lip mode is not implemented")
    if type(blink_enabled) is not bool or blink_enabled:
        raise ValueError("Blink export is not implemented")
    if fps not in (24, 30, 60):
        raise ValueError("Unsupported frame rate")
    if mov.suffix.lower() != ".mov" or otio.suffix.lower() != ".otio":
        raise ValueError("Expected MOV and OTIO destinations")
    if mov.parent != otio.parent:
        raise ValueError("MOV and OTIO must be in one output directory")
    prior = initial_target_identity(mov, otio, conflict_policy)

    psd, base = validated_snapshot(psd_path, fingerprint, layers)
    shapes = validate_open_mouth(psd, base, mouth) if mode == "open" else None
    schedule = analyze_wav(wav, fps=fps)
    indices = tuple(1 if shapes and frame.mouth == "open" else 0
                    for frame in schedule.frames)
    work = tempfile.TemporaryDirectory(prefix=".tachie-preset-", dir=mov.parent)
    committed = False
    cleanup_warning = None
    try:
        directory = Path(work.name)
        pngs = []
        for state in (("closed", "opened") if shapes else ("base",)):
            if shapes:
                for path, visible in shapes[state].items():
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
        # The OTIO builder requires an already-existing MOV. Build against the
        # fully verified staged movie, then write the final publication URI
        # before publishing either output. Both paths use the validated folder.
        document = build_rounded_utterance(
            staged_mov, wav, MovieTiming(report.frames, fps),
            WaveTiming(schedule.sample_count, schedule.sample_rate),
        )
        video_ref = document["tracks"]["children"][0]["children"][0][
            "media_references"]["DEFAULT_MEDIA"]
        video_ref["target_url"] = mov.as_uri()
        video_ref["name"] = mov.name
        staged_otio = directory / "staged.otio"
        write_otio(document, staged_otio)
        # Validate and stage both outputs BEFORE touching any published media.
        warning = publish_pair(
            staged_mov, staged_otio, mov, otio,
            policy=conflict_policy, prior=prior,
        )
        committed = True
    finally:
        try:
            work.cleanup()
        except OSError:
            if not committed:
                raise
            cleanup_warning = (
                "MOV and OTIO were saved, but temporary render files could not "
                "be fully removed: " + work.name
            )
    result = {"mov": str(mov), "otio": str(otio), "frames": report.frames,
              "sample_count": schedule.sample_count}
    warnings = [message for message in (warning, cleanup_warning) if message]
    if warnings:
        result["warning"] = " ".join(warnings)
    return result
