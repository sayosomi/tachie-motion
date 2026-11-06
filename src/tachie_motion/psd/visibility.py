"""Explicit PSD visibility changes, addressed by snapshot-local index paths.

Only alters an in-memory PSDImage loaded for rendering. The source PSD is
never saved or rewritten. No layer names or character parts are inferred.
"""

from collections.abc import Sequence
from dataclasses import dataclass

from psd_tools import PSDImage
from psd_tools.api.layers import Layer


IndexPath = tuple[int, ...]


@dataclass(frozen=True, slots=True)
class VisibilityChange:
    path: IndexPath
    name: str
    before: bool
    after: bool


def parse_index_path(raw: str) -> IndexPath:
    """Parse the 0-based paths displayed by tachie-psd-inspect."""
    components = raw.split("/")
    if not components or any(not value.isdecimal() for value in components):
        raise ValueError(f"Invalid layer path {raw!r}; expected e.g. 4/0")
    return tuple(int(component) for component in components)


def resolve_layer(psd: PSDImage, path: IndexPath) -> Layer:
    """Resolve by child indices, never by a potentially duplicate layer name."""
    if not path:
        raise ValueError("Layer path cannot be empty")
    parent = psd
    for depth, index in enumerate(path):
        if index >= len(parent):
            raise ValueError(f"Layer path not found: {'/'.join(map(str, path))}")
        layer = parent[index]
        if depth != len(path) - 1:
            if not layer.is_group():
                raise ValueError(
                    f"Cannot descend into non-group layer at index {index}"
                )
            parent = layer
    return layer


def apply_visibility(
    psd: PSDImage,
    *,
    show: Sequence[str] = (),
    hide: Sequence[str] = (),
) -> list[VisibilityChange]:
    """Validate all edits first, then change only explicitly selected layers.

    Showing a layer with a hidden parent requires explicitly showing the
    parent too. No implicit group or sibling changes are permitted.
    """
    requested: dict[IndexPath, bool] = {}
    for paths, visible in ((show, True), (hide, False)):
        for raw in paths:
            path = parse_index_path(raw)
            if path in requested:
                raise ValueError(f"Layer path specified more than once: {raw}")
            requested[path] = visible

    if not requested:
        raise ValueError("At least one --show or --hide is required")

    resolved = {path: resolve_layer(psd, path) for path in requested}
    for path, visible in requested.items():
        if not visible:
            continue
        for end in range(1, len(path)):
            ancestor_path = path[:end]
            ancestor = resolve_layer(psd, ancestor_path)
            effective = requested.get(ancestor_path, ancestor.visible)
            if not effective:
                raise ValueError(
                    "Cannot show a layer inside a hidden group: "
                    + "/".join(map(str, path))
                    + " (also show "
                    + "/".join(map(str, ancestor_path))
                    + ")"
                )

    changes = [
        VisibilityChange(path, layer.name, bool(layer.visible), requested[path])
        for path, layer in resolved.items()
    ]
    for path, layer in resolved.items():
        layer.visible = requested[path]
    return changes
