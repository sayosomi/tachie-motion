"""Conservative, read-only layer assets for optional browser-only PSD preview.

Never use these downsampled images for MOV/OTIO/ProRes. Unsupported PSDs
return supported=False so the unchanged Python compositor remains authoritative.
"""

from base64 import b64encode
from io import BytesIO

from PIL import Image

from tachie_motion.psd.tree import walk_layers
from tachie_motion.psd.visibility import resolve_layer
from tachie_motion.web.preview_frame import file_identity, is_roi_safe
from tachie_motion.web.service import load_psd, local_file

MAX_PSD_PIXELS = 6_000_000
MAX_LAYERS = 256
MAX_EDGE = 900
MAX_SOURCE_SIDE = 12_000
MAX_SOURCE_LAYER_PIXELS = 12_000_000
MAX_SOURCE_TOTAL_PIXELS = 100_000_000
MAX_DECODED_BYTES = 128 * 1024 * 1024
MAX_PNG_BYTES = 32 * 1024 * 1024


def _scaled_box(bbox, source_size, target_size):
    width, height = source_size
    dest_width, dest_height = target_size
    left, top, right, bottom = bbox
    left, top = max(0, left), max(0, top)
    right, bottom = min(width, right), min(height, bottom)
    if left >= right or top >= bottom:
        return None
    # Clipped coordinates are nonnegative; use JavaScript Math.round's
    # half-up rule rather than Python's ties-to-even round().
    def scaled(value, target, origin):
        return (2 * value * target + origin) // (2 * origin)

    box = (
        scaled(left, dest_width, width),
        scaled(top, dest_height, height),
        scaled(right, dest_width, width),
        scaled(bottom, dest_height, height),
    )
    return box if box[0] < box[2] and box[1] < box[3] else None


def _within_raw_budget(summaries):
    total = 0
    for layer in summaries:
        if layer.kind != "pixel":
            continue
        left, top, right, bottom = layer.bbox
        width, height = right - left, bottom - top
        if (width < 0 or height < 0 or width > MAX_SOURCE_SIDE
                or height > MAX_SOURCE_SIDE
                or width * height > MAX_SOURCE_LAYER_PIXELS):
            return False
        total += width * height
        if total > MAX_SOURCE_TOTAL_PIXELS:
            return False
    return True


def _identity_token(identity: tuple[int, int, int, int, int]) -> str:
    """Preserve nanosecond timestamps exactly across the JSON/JS boundary."""
    return ":".join(map(str, identity))


def preview_source_status(raw: str, fingerprint: str, source_identity: str) -> dict:
    """Cheap metadata-only revalidation; no PSD open, decoding or compositing."""
    if not isinstance(source_identity, str) or not source_identity:
        raise ValueError("Preview source identity is required")
    try:
        source = local_file(raw, ".psd")
        current = file_identity(source)
    except (ValueError, OSError):
        # The once-loaded PSD may have been renamed, replaced or unmounted.
        # A missing source is not a valid canvas snapshot.
        return {"valid": False}
    return {"valid": (fingerprint == f"{current[3]}:{current[4]}"
                      and source_identity == _identity_token(current))}


def layer_preview_assets(raw: str, fingerprint: str) -> dict:
    """Return a bounded, source-checked PNG layer snapshot or a fallback signal."""
    source = local_file(raw, ".psd")
    identity = file_identity(source)
    if fingerprint != f"{identity[3]}:{identity[4]}":
        raise ValueError("PSD has changed; reload it before editing presets")
    psd = load_psd(str(source))
    if file_identity(source) != identity:
        raise ValueError("PSD changed during load; reload before editing")
    if psd.width * psd.height > MAX_PSD_PIXELS or not is_roi_safe(psd):
        return {"supported": False}

    summaries = list(walk_layers(psd))
    if len(summaries) > MAX_LAYERS or not _within_raw_budget(summaries):
        return {"supported": False}
    scale = min(1.0, MAX_EDGE / psd.width, MAX_EDGE / psd.height)
    target_size = (max(1, round(psd.width * scale)),
                   max(1, round(psd.height * scale)))
    source_size = (psd.width, psd.height)

    # Pre-compute memory budget before topil() allocates raw layer images.
    decoded = 0
    for layer in summaries:
        if layer.kind != "pixel":
            continue
        box = _scaled_box(layer.bbox, source_size, target_size)
        left, top, right, bottom = layer.bbox
        if (box is None and max(0, left) < min(psd.width, right)
                and max(0, top) < min(psd.height, bottom)):
            return {"supported": False}
        if box is not None:
            decoded += 4 * (box[2] - box[0]) * (box[3] - box[1])
            if decoded > MAX_DECODED_BYTES:
                return {"supported": False}

    rows = []
    encoded_size = 0
    for summary in summaries:
        path = "/".join(map(str, summary.index_path))
        row = {"path": path, "visible": bool(summary.visible),
               "kind": summary.kind, "rect": None, "png": None}
        if summary.kind == "pixel":
            box = _scaled_box(summary.bbox, source_size, target_size)
            if box is not None:
                layer = resolve_layer(psd, summary.index_path)
                original = layer.topil()
                if original is None:
                    return {"supported": False}
                left, top, right, bottom = summary.bbox
                if original.size != (right - left, bottom - top):
                    return {"supported": False}
                clip = (max(0, -left), max(0, -top),
                        min(right, psd.width) - left,
                        min(bottom, psd.height) - top)
                sized = original.convert("RGBA").crop(clip).resize(
                    (box[2] - box[0], box[3] - box[1]), Image.Resampling.LANCZOS,
                )
                with BytesIO() as buffer:
                    sized.save(buffer, format="PNG")
                    data = buffer.getvalue()
                encoded_size += len(data)
                if encoded_size > MAX_PNG_BYTES:
                    return {"supported": False}
                row["rect"] = [box[0], box[1], sized.width, sized.height]
                row["png"] = "data:image/png;base64," + b64encode(data).decode("ascii")
        rows.append(row)

    if file_identity(source) != identity:
        raise ValueError("PSD changed during layer extraction; reload before editing")
    return {"supported": True, "width": target_size[0], "height": target_size[1],
            "source_width": psd.width, "source_height": psd.height,
            "source_identity": _identity_token(identity), "layers": rows}
