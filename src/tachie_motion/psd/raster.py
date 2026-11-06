"""Render PSD layers to transparent PNG without saving the PSD source.

PoC-only: visibility editing is handled in the separate visibility module.
"""

from pathlib import Path

from psd_tools import PSDImage


def composite_rgba(psd: PSDImage):
    """Composite the current PSD visibility on the unmodified full canvas."""
    rendered = psd.composite(
        viewport=(0, 0, psd.width, psd.height),
        force=True,
        ignore_preview=True,
        alpha=0.0,
    )
    if rendered is None:
        raise RuntimeError("PSD layer compositing returned no image")
    if rendered.size != (psd.width, psd.height):
        raise RuntimeError("PSD composite did not preserve full canvas dimensions")
    return rendered.convert("RGBA")


def write_layer_png(psd: PSDImage, output: Path) -> Path:
    """Render the current layer state on the fixed full-PSD canvas."""
    rgba = composite_rgba(psd)
    output.parent.mkdir(parents=True, exist_ok=True)
    rgba.save(output)
    return output


def write_comparison_images(
    psd: PSDImage, output_dir: Path
) -> dict[str, Path]:
    """Export the embedded PSD reference and freshly composited visible layers.

    The preview is a reference, not necessarily an alpha-bearing image.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, Path] = {}

    reference = psd.topil()
    if reference is not None:
        target = output_dir / "embedded-preview.png"
        reference.save(target)
        results["embedded"] = target

    results["layers"] = write_layer_png(
        psd, output_dir / "layers-transparent.png"
    )
    return results
