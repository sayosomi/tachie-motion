"""Read the original PSD layer hierarchy without mutating the source."""

from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from psd_tools.api.layers import Layer


@dataclass(frozen=True, slots=True)
class LayerSummary:
    """A layer and its index path in the current PSD snapshot."""

    index_path: tuple[int, ...]
    name: str
    kind: str
    visible: bool
    effective_visible: bool
    bbox: tuple[int, int, int, int]


def walk_layers(
    layers: Iterable[Layer],
    prefix: tuple[int, ...] = (),
) -> Iterator[LayerSummary]:
    """Yield layers in source order; groups precede their children.

    An index path distinguishes duplicate names. It is valid only while
    the PSD layer ordering remains unchanged (not a persistent layer ID).
    """
    for index, layer in enumerate(layers):
        path = (*prefix, index)
        yield LayerSummary(
            index_path=path,
            name=layer.name,
            kind=layer.kind,
            visible=layer.visible,
            effective_visible=layer.is_visible(),
            bbox=tuple(layer.bbox),
        )
        if layer.is_group():
            yield from walk_layers(layer, path)
