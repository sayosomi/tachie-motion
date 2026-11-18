"""Validate the explicit closed-eye pose without changing PSD source state.

The resting open-eye pose always comes from the preset's fixed visibility.
Only the assigned eye groups can be overridden during a blink.
"""

from pathlib import Path

from tachie_motion.psd.crop import write_fixed_crop_png
from tachie_motion.psd.tree import walk_layers
from tachie_motion.psd.visibility import parse_index_path, resolve_layer

from tachie_motion.web.aiueo_renderer import validate_psdtool_state


def _assigned_groups(raw, source: dict, label: str, *, required: bool):
    if (type(raw) is not list or (required and not raw)
            or any(type(path) is not str for path in raw)):
        raise ValueError(label + " requires assigned PSD groups")
    paths = tuple(parse_index_path(path) for path in raw)
    if len(set(paths)) != len(paths) or any(
            path not in source or source[path].kind != "group"
            for path in paths):
        raise ValueError(label + " has unknown or duplicate PSD groups")
    return paths


def validate_closed_eye(
    psd, base: dict, eyes: dict | None,
    eye_groups: list[str] | None,
    mouth_groups: list[str] | None = None,
) -> dict:
    """Return a full closed-eye visibility map without mutating the PSD.

    All editable eye leaves in assigned groups start hidden in the closed pose;
    only explicit true selections then become visible. Mandatory ! leaves stay
    fixed. A selected leaf may coincide with its fixed open-eye counterpart.
    """
    summaries = tuple(walk_layers(psd))
    source = {item.index_path: item for item in summaries}
    if set(base) != set(source) or any(type(value) is not bool for value in base.values()):
        raise ValueError("Eye fixed layers do not match the PSD snapshot")
    validate_psdtool_state(summaries, base, "eye fixed pose")

    if type(eyes) is not dict or set(eyes) != {"opened", "closed"}:
        raise ValueError("Blink requires a complete eyes shape")
    if type(eyes["opened"]) is not list or eyes["opened"]:
        raise ValueError("Blink open pose must use fixed layers only")
    entries = eyes["closed"]
    if type(entries) is not list or not 0 < len(entries) <= 50_000:
        raise ValueError("Blink requires an explicitly selected closed eye")

    eye_paths = _assigned_groups(eye_groups, source, "Blink", required=True)
    mouth_paths = (_assigned_groups(mouth_groups, source, "Mouth", required=False)
                   if mouth_groups is not None else ())
    if any(a[:len(b)] == b or b[:len(a)] == a
           for a in eye_paths for b in mouth_paths):
        raise ValueError("Mouth and eye PSD groups cannot overlap")

    editable = {
        item.index_path for item in summaries
        if item.kind != "group" and not item.name.startswith("!")
        and any(item.index_path[:len(group)] == group
                and len(item.index_path) > len(group) for group in eye_paths)
    }
    selected = {}
    for entry in entries:
        if (type(entry) is not dict or set(entry) != {"path", "visible"}
                or type(entry["path"]) is not str
                or type(entry["visible"]) is not bool):
            raise ValueError("Invalid closed-eye layer target")
        path = parse_index_path(entry["path"])
        if path in selected or path not in editable:
            raise ValueError("Duplicate or outside-group closed-eye layer")
        if any(base.get(path[:i]) is False for i in range(1, len(path))):
            raise ValueError("Closed-eye layer has a hidden parent")
        selected[path] = entry["visible"]
    if not any(selected.values()):
        raise ValueError("Blink requires an explicitly selected closed eye")

    # PSDTool * radio siblings can mix pixel leaves and groups. Choosing an
    # explicit eye leaf must also hide a starred sibling group in the same
    # assigned eye area, without changing the resting fixed group selection.
    # Never hide starred groups outside the explicitly assigned eye groups.
    selected_radio_parents = {
        path[:-1] for path, visible in selected.items()
        if visible and source[path].name.startswith("*")
    }
    radio_groups_to_hide = {
        item.index_path for item in summaries
        if item.kind == "group" and item.name.startswith("*")
        and item.index_path[:-1] in selected_radio_parents
        and any(item.index_path[:len(group)] == group
                and len(item.index_path) > len(group) for group in eye_paths)
    }
    closed = {
        **base, **dict.fromkeys(editable, False),
        **dict.fromkeys(radio_groups_to_hide, False), **selected,
    }
    validate_psdtool_state(summaries, closed, "eye closed pose")
    return closed


def render_blink_states(
    psd, base: dict, closed_eye: dict,
    mouth_poses: tuple[dict, ...], directory: Path,
) -> list[Path]:
    """Render open/closed eye PNG for each mouth pose in stable index order.

    The returned PNG list is indexed by mouth_pose * 2 + closed_bit.
    Every state is independently composed from the full preset base.
    """
    if not mouth_poses:
        raise ValueError("At least one mouth pose is required")
    summaries = tuple(walk_layers(psd))
    expected = {item.index_path for item in summaries}
    if set(base) != expected or set(closed_eye) != expected:
        raise ValueError("Blink poses do not cover the original PSD")
    pngs = []
    for mouth_index, overrides in enumerate(mouth_poses):
        if type(overrides) is not dict or any(
                path not in expected or type(visible) is not bool
                for path, visible in overrides.items()):
            raise ValueError("Invalid mouth override in combined blink")
        for blink_closed in (False, True):
            pose = {**(closed_eye if blink_closed else base), **overrides}
            validate_psdtool_state(summaries, pose, "combined mouth/eye pose")
            for path, visible in pose.items():
                resolve_layer(psd, path).visible = visible
            png = directory / f"mouth-{mouth_index}-eye-{int(blink_closed)}.png"
            write_fixed_crop_png(psd, png, padding=16)
            pngs.append(png)
    return pngs
