"""Validated PCM-sample change points for one WAV's preset timeline.

The first segment uses the utterance's original preset. Changes are ordered,
strictly within the original WAV, and become effective at their sample index.
All frame resolution uses the same middle-sample rule as aiueo.
"""

MAX_PRESET_CHANGE_POINTS = 2048
_FIELDS = frozenset({
    "sample", "preset_id", "layers", "mouth", "aiueo_mouth",
    "mode", "blink_enabled", "eyes", "blink_timing",
})


def validate_timeline_changes(raw: object, *, samples: int) -> tuple[dict, ...]:
    if type(samples) is not int or samples < 1:
        raise ValueError("WAV sample count must be positive")
    if raw is None:
        return ()
    if type(raw) is not list or len(raw) > MAX_PRESET_CHANGE_POINTS:
        raise ValueError("Invalid preset change-point list")
    previous = 0
    result: list[dict] = []
    for point in raw:
        if type(point) is not dict or set(point) != _FIELDS:
            raise ValueError("Malformed preset change-point fields")
        sample, preset_id = point["sample"], point["preset_id"]
        if type(sample) is not int or not previous < sample < samples:
            raise ValueError("Preset change-point sample is invalid or out of order")
        if (type(preset_id) is not str or not preset_id or len(preset_id) > 256):
            raise ValueError("Invalid preset change-point reference")
        if type(point["layers"]) is not list:
            raise ValueError("Preset change-point layers must be a list")
        if (point["mode"] not in ("none", "open", "aiueo") or
                type(point["mode"]) is not str or
                type(point["blink_enabled"]) is not bool):
            raise ValueError("Invalid preset change-point motion")
        if point["mouth"] is not None and type(point["mouth"]) is not dict:
            raise ValueError("Invalid change-point Open mouth")
        if point["aiueo_mouth"] is not None and type(point["aiueo_mouth"]) is not dict:
            raise ValueError("Invalid change-point aiueo mouth")
        if point["eyes"] is not None and type(point["eyes"]) is not dict:
            raise ValueError("Invalid change-point eyes")
        if point["blink_timing"] is not None and type(point["blink_timing"]) is not dict:
            raise ValueError("Invalid change-point blink timing")
        result.append(point)
        previous = sample
    return tuple(result)


def segments_by_frame(
    changes: tuple[dict, ...], *,
    samples: int, sample_rate: int, fps: int, frame_count: int,
) -> tuple[int, ...]:
    """Choose the active segment at each existing video's center PCM sample."""
    if (type(sample_rate) is not int or sample_rate < 1 or
            type(fps) is not int or fps not in (24, 30, 60) or
            type(frame_count) is not int or frame_count < 1):
        raise ValueError("Invalid frame schedule")
    if frame_count != (samples * fps + sample_rate - 1) // sample_rate:
        raise ValueError("Video frame count does not match WAV samples")
    position = 0
    result: list[int] = []
    for frame in range(frame_count):
        sample = min(samples - 1, ((2 * frame + 1) * sample_rate) // (2 * fps))
        while position < len(changes) and sample >= changes[position]["sample"]:
            position += 1
        result.append(position)
    return tuple(result)
