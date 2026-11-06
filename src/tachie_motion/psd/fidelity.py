"""Conservative risk diagnostics for PSD features with uncertain compositing.

This does not infer character parts. Risks are reported, not silently treated
as proof that the rendering matches Photoshop.
"""

from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from psd_tools.constants import BlendMode


@dataclass(frozen=True, slots=True)
class FidelityRisk:
    index_path: tuple[int, ...]
    layer_name: str
    feature: str
    detail: str


def _feature_flag(layer, method_name: str) -> bool:
    method = getattr(layer, method_name, None)
    if callable(method):
        return bool(method())
    return False


def find_fidelity_risks(
    layers: Iterable, prefix: tuple[int, ...] = ()
) -> Iterator[FidelityRisk]:
    """Recursively flag unsupported/partial PSD features in original order."""
    for index, layer in enumerate(layers):
        path = (*prefix, index)
        name = layer.name
        kind = str(layer.kind)
        if kind not in ("group", "pixel"):
            yield FidelityRisk(
                path, name, "layer-kind",
                f"{kind}: non-pixel layer compositing may be limited",
            )
        blend = getattr(layer, "blend_mode", BlendMode.NORMAL)
        if blend != BlendMode.NORMAL:
            yield FidelityRisk(
                path, name, "blend-mode",
                f"{blend}: requires Photoshop/reference image comparison",
            )
        if bool(getattr(layer, "clipping", False)):
            yield FidelityRisk(
                path, name, "clipping",
                "Clipping layers require visual comparison",
            )
        if _feature_flag(layer, "has_mask"):
            yield FidelityRisk(
                path, name, "pixel-mask",
                "Mask compositing requires visual comparison",
            )
        if _feature_flag(layer, "has_vector_mask"):
            yield FidelityRisk(
                path, name, "vector-mask",
                "Vector masks are partially supported; compare visually",
            )
        effects = getattr(layer, "effects", None)
        if effects is not None and bool(effects):
            yield FidelityRisk(
                path, name, "effects",
                "Layer effects are not fully supported by psd-tools",
            )
        if layer.is_group():
            yield from find_fidelity_risks(layer, path)
