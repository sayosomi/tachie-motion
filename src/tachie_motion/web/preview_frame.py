"""Bounded full-RGBA cache for conservative PSD visibility preview updates.

Only the Web preview uses this cache. It never retains PSDImage objects or
modifies the source. Callers serialize prepare/publish with `preview_lock`
and publish a candidate only after checking source identity again.
"""

from __future__ import annotations

from base64 import b64encode
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from threading import RLock
from typing import Callable

from PIL import Image
from psd_tools import PSDImage
from psd_tools.constants import BlendMode, ColorMode

from tachie_motion.presets import LayerState
from tachie_motion.psd.raster import composite_rgba


# A single 1500x3300 RGBA image is 19.8 MB. Do not retain giant canvases or
# separate full-resolution variants for every preset.
MAX_FRAME_BYTES = 32 * 1024 * 1024
MAX_ROI_FRACTION = 0.40
preview_lock = RLock()


@dataclass(frozen=True, slots=True)
class Frame:
    path: str
    identity: tuple[int, int, int, int, int]
    states: tuple[LayerState, ...]
    rgba: Image.Image


_last_frame: Frame | None = None


def clear_frame_cache() -> None:
    global _last_frame
    with preview_lock:
        _last_frame = None


def file_identity(source: Path) -> tuple[int, int, int, int, int]:
    info = source.stat()
    return (info.st_dev, info.st_ino, info.st_ctime_ns,
            info.st_size, info.st_mtime_ns)


def thumbnail_from_rgba(image: Image.Image) -> str:
    """Keep the exact existing 900px Pillow/PNG encoding; never resize cache."""
    thumbnail = image.copy()
    thumbnail.thumbnail((900, 900))
    with BytesIO() as stream:
        thumbnail.save(stream, format="PNG")
        return "data:image/png;base64," + b64encode(stream.getvalue()).decode("ascii")


def _feature(layer: object, name: str) -> bool:
    value = getattr(layer, name, None)
    return bool(value()) if callable(value) else False


def is_roi_safe(psd: PSDImage) -> bool:
    """Conservative local-pixel-only subset; other PSDs use full compositing.

    A changed layer bbox is not a safe dirty rectangle for masks, effects,
    adjustments, clipping, non-normal blending, group opacity or exotic PSD
    modes. Reject the *entire* document when such a layer is present.
    """
    if psd.color_mode != ColorMode.RGB or psd.depth != 8:
        return False

    def inspect(children) -> bool:
        for layer in children:
            is_group = layer.is_group()
            if layer.kind not in ("group", "pixel"):
                return False
            blends = (BlendMode.NORMAL, BlendMode.PASS_THROUGH) if is_group else (BlendMode.NORMAL,)
            if layer.blend_mode not in blends:
                return False
            if getattr(layer, "opacity", 255) != 255:
                return False
            if getattr(layer, "fill_opacity", 255) != 255:
                return False
            if getattr(layer, "clipping", False):
                return False
            if _feature(layer, "has_mask") or _feature(layer, "has_vector_mask"):
                return False
            if bool(getattr(layer, "effects", None)):
                return False
            if is_group and not inspect(layer):
                return False
        return True

    return inspect(psd)


def region_bbox(
    bbox: tuple[int, int, int, int], width: int, height: int,
) -> tuple[int, int, int, int] | None:
    left, top, right, bottom = bbox
    region = (max(0, left), max(0, top), min(width, right), min(height, bottom))
    if region[0] >= region[2] or region[1] >= region[3]:
        return None
    area = (region[2] - region[0]) * (region[3] - region[1])
    if area / (width * height) >= MAX_ROI_FRACTION:
        return None
    return region


def composite_roi(psd: PSDImage, box: tuple[int, int, int, int]) -> Image.Image:
    image = psd.composite(
        viewport=box, force=True, ignore_preview=True, alpha=0.0,
    )
    if image is None or image.size != (box[2] - box[0], box[3] - box[1]):
        raise RuntimeError("PSD ROI composite returned invalid dimensions")
    return image.convert("RGBA")


def _changed_leaf(
    psd: PSDImage, old: tuple[LayerState, ...],
    current: tuple[LayerState, ...],
):
    if len(old) != len(current):
        return None
    changed = []
    for prev, now in zip(old, current):
        if prev.path != now.path:
            return None
        if prev.visible != now.visible:
            changed.append(now.path)
            if len(changed) > 1:
                return None
    if len(changed) != 1:
        return None

    parent = psd
    for index in changed[0]:
        if index >= len(parent):
            return None
        leaf = parent[index]
        parent = leaf
    if leaf.is_group() or leaf.kind != "pixel":
        return None
    return region_bbox(tuple(leaf.bbox), psd.width, psd.height)


def prepare_initial(
    psd: PSDImage, path: str, identity: tuple[int, int, int, int, int],
    states: tuple[LayerState, ...],
    fallback: Callable[[], str],
) -> tuple[str, Frame | None]:
    """Return preview and optional unpublished full-resolution image."""
    if (psd.width * psd.height * 4 > MAX_FRAME_BYTES
            or not is_roi_safe(psd)):
        return fallback(), None
    rgba = composite_rgba(psd)
    preview = thumbnail_from_rgba(rgba)
    return preview, Frame(path, identity, states, rgba)


def prepare_updated(
    psd: PSDImage, path: str, identity: tuple[int, int, int, int, int],
    states: tuple[LayerState, ...],
    fallback: Callable[[], str],
) -> tuple[str, Frame | None]:
    """Try exact-snapshot single-leaf viewport render; otherwise full render."""
    if (psd.width * psd.height * 4 > MAX_FRAME_BYTES
            or not is_roi_safe(psd)):
        return fallback(), None

    previous = _last_frame
    box = None
    if previous is not None and previous.path == path and previous.identity == identity:
        box = _changed_leaf(psd, previous.states, states)

    if box is None:
        rgba = composite_rgba(psd)
    else:
        try:
            roi = composite_roi(psd, box)
            rgba = previous.rgba.copy()
            # The ROI contains the complete resulting composite. Blending it
            # onto the prior output would change alpha and RGB values.
            rgba.paste(roi, box[:2])
        except (RuntimeError, ValueError, OSError):
            # Never publish a partial image on failed viewport compositing.
            rgba = composite_rgba(psd)
    preview = thumbnail_from_rgba(rgba)
    return preview, Frame(path, identity, states, rgba)


def publish(candidate: Frame | None) -> None:
    """Only call after validating source identity, under preview_lock."""
    global _last_frame
    if candidate is not None:
        _last_frame = candidate
