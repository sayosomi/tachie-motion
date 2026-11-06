"""Immutable unified-preset domain data, independent of the PSD renderer/UI.

Layer paths are indices into ONE PSD hierarchy snapshot. They are not durable
layer IDs across edits to the source PSD. No visibility-evaluation policy or
project-file schema is defined here.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from uuid import uuid4


@dataclass(frozen=True, slots=True)
class LayerState:
    """An explicit ON/OFF value for a snapshot-local PSD index path."""

    path: tuple[int, ...]
    visible: bool

    def __post_init__(self) -> None:
        if not isinstance(self.path, tuple) or not self.path or any(
            type(index) is not int or index < 0 for index in self.path
        ):
            raise ValueError("Layer path must be a nonempty tuple of nonnegative indices")
        if type(self.visible) is not bool:
            raise ValueError("Layer visibility must be ON or OFF")


@dataclass(frozen=True, slots=True)
class LayerStateSet:
    """Immutable layer settings (not a rendered or evaluated visibility map)."""

    layers: tuple[LayerState, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.layers, tuple) or any(
            not isinstance(layer, LayerState) for layer in self.layers
        ):
            raise ValueError("Layer states must be an immutable tuple")
        paths = [layer.path for layer in self.layers]
        if len(paths) != len(set(paths)):
            raise ValueError("Layer path specified more than once in one state")


@dataclass(frozen=True, slots=True)
class OpenMouth:
    closed: LayerStateSet
    opened: LayerStateSet

    def __post_init__(self) -> None:
        if not all(isinstance(x, LayerStateSet) for x in (self.closed, self.opened)):
            raise ValueError("Mouth shapes must contain immutable layer states")


@dataclass(frozen=True, slots=True)
class AiueoMouth:
    """The 'n' state represents ん and rest/silence, not an inferred LAB."""

    a: LayerStateSet
    i: LayerStateSet
    u: LayerStateSet
    e: LayerStateSet
    o: LayerStateSet
    n: LayerStateSet

    def __post_init__(self) -> None:
        if not all(isinstance(x, LayerStateSet) for x in (
            self.a, self.i, self.u, self.e, self.o, self.n
        )):
            raise ValueError("Aiueo shapes must contain immutable layer states")


@dataclass(frozen=True, slots=True)
class EyeStates:
    opened: LayerStateSet
    closed: LayerStateSet

    def __post_init__(self) -> None:
        if not all(isinstance(x, LayerStateSet) for x in (self.opened, self.closed)):
            raise ValueError("Eye shapes must contain immutable layer states")


@dataclass(frozen=True, slots=True)
class Preset:
    """One named, unified expression/pose preset; never a separate lip mode."""

    id: str
    name: str
    base: LayerStateSet
    open_mouth: OpenMouth | None = None
    aiueo_mouth: AiueoMouth | None = None
    eyes: EyeStates | None = None
    blink_enabled: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or not self.id.strip():
            raise ValueError("Preset ID must be nonempty")
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("Preset name must be nonempty")
        if not isinstance(self.base, LayerStateSet):
            raise ValueError("Preset base must contain layer ON/OFF settings")
        for item, kind in (
            (self.open_mouth, OpenMouth),
            (self.aiueo_mouth, AiueoMouth),
            (self.eyes, EyeStates),
        ):
            if item is not None and not isinstance(item, kind):
                raise ValueError("Invalid optional preset animation state")
        if type(self.blink_enabled) is not bool:
            raise ValueError("Blink flag must be ON or OFF")


def new_preset(name: str, base: LayerStateSet) -> Preset:
    """Allocate a stable identity independent of name, layer order and UI order."""
    return Preset(id=uuid4().hex, name=name, base=base)


@dataclass(frozen=True, slots=True)
class PresetCollection:
    """Pure preset list operations. Deletion/reference policy is deferred."""

    presets: tuple[Preset, ...] = ()
    default_id: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.presets, tuple) or any(
            not isinstance(preset, Preset) for preset in self.presets
        ):
            raise ValueError("Presets must be an immutable tuple")
        ids = [preset.id for preset in self.presets]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate preset ID")
        if self.presets and self.default_id not in ids:
            raise ValueError("Default preset ID must refer to a preset")
        if not self.presets and self.default_id is not None:
            raise ValueError("An empty collection cannot have a default")

    def _index(self, preset_id: str) -> int:
        for index, preset in enumerate(self.presets):
            if preset.id == preset_id:
                return index
        raise ValueError(f"Preset ID not found: {preset_id}")

    def append(self, preset: Preset) -> PresetCollection:
        if not isinstance(preset, Preset):
            raise ValueError("Expected a preset")
        return PresetCollection(
            self.presets + (preset,),
            self.default_id if self.presets else preset.id,
        )

    def duplicate(self, preset_id: str) -> PresetCollection:
        """Duplicate immediately after source; all contained values are immutable."""
        index = self._index(preset_id)
        copy = replace(self.presets[index], id=uuid4().hex)
        return PresetCollection(
            self.presets[: index + 1] + (copy,) + self.presets[index + 1 :],
            self.default_id,
        )

    def rename(self, preset_id: str, name: str) -> PresetCollection:
        index = self._index(preset_id)
        updated = replace(self.presets[index], name=name)
        return PresetCollection(
            self.presets[:index] + (updated,) + self.presets[index + 1 :],
            self.default_id,
        )

    def reorder(self, preset_ids: tuple[str, ...]) -> PresetCollection:
        if not isinstance(preset_ids, tuple) or (
            len(preset_ids) != len(self.presets)
            or any(not isinstance(item, str) for item in preset_ids)
            or len(preset_ids) != len(set(preset_ids))
            or set(preset_ids) != {preset.id for preset in self.presets}
        ):
            raise ValueError("Reorder must contain each preset ID exactly once")
        by_id = {preset.id: preset for preset in self.presets}
        return PresetCollection(tuple(by_id[id] for id in preset_ids), self.default_id)

    def set_default(self, preset_id: str) -> PresetCollection:
        self._index(preset_id)
        return PresetCollection(self.presets, preset_id)
