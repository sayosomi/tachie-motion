# PSD compositor fidelity — Phase 0 scope and limitations

Status: Phase 0 characterization, **not** a Photoshop-fidelity guarantee.
Target library: `psd-tools>=1.26,<2`, with `PSDImage.composite(force=True,
ignore_preview=True, alpha=0.0)`.

## Verified in this project's tests and human PoC

- A real 2048×2048 layered character PSD with Japanese layer names loaded.
- Nested groups, original layer order, duplicate names, and individual visibility
  edits by index path work with a synthetic PSD saved and reopened by psd-tools.
- A separate generated PSD carrying a MULTIPLY layer is saved, reopened, checked
  for retained blend-mode metadata and composited by psd-tools. This is a
  **capability smoke test**, not a Photoshop pixel-equivalence test.
- On the user's one real PSD, two **mouth** states were exported with identical
  size/origin, compared visually with the reference PSD appearance, and imported
  into DaVinci Resolve with acceptable alpha/edges (user-reported on Mac).
- All leaf layer bboxes, including hidden alternatives, are included in a
  conservative fixed crop; rendered current-state alpha is checked against it.
- PNG and MOV outputs are independent of source PSD bytes: synthetic integration
  tests compare the original PSD's SHA-256 before/after in-memory editing.

## Partially supported or not proven

The psd-tools upstream documentation notes limitations in composition of
many layer effects, smart objects, some adjustment layers, color modes, masks,
and blend modes. The current Phase 0 tests **do not establish pixel fidelity**
for every combination. Individual unsupported features can create color
differences, unexpected edges or invisible elements even if a PNG is valid.

| PSD feature | Phase 0 conclusion | Risk |
| --- | --- | --- |
| Basic RGBA pixel layers, groups, visibility | Tested; basic cases PASS | Other composites may differ |
| Hidden mouth/eye/pose alternative bounds | Union tested; not all combinations exhaustively rendered | Future state may expose effect pixels beyond crop |
| Non-normal blend modes | MULTIPLY synthetic file read/write and composite smoke test; **not independently Photoshop-verified** | Color and edge differences |
| Clipping masks and pixel/vector masks | **Not independently Photoshop-verified** | Cutouts may be missing or shifted |
| Adjustment layers, effects | Partial/unsupported; **not certified** | Tone, shadow, glow and outlines differ |
| Text, shape, smart object rendering | Not covered in Phase 0 | Fallback raster/flattening may be required |
| CMYK, LAB, multichannel color modes | Not covered in Phase 0 | ICC/conversion differences |
| Photoshop effects extending past layer bbox | Not guaranteed by bbox-only union | Extra margin needed; visible state is checked for clipped alpha |

Upstream evidence: https://psd-tools.readthedocs.io/en/latest/ and
https://github.com/psd-tools/psd-tools/blob/main/docs/usage.rst

## Diagnosis and human acceptance protocol

Run `tachie-psd-fidelity "/path/to/character.psd"` to enumerate layers
using risky features. This scan is intentionally conservative: **no warnings
does not imply Photoshop-equivalent rendering**. It never saves the source.

For each PSD planned for production, visually compare the original merged
preview/Photoshop rendering with `tachie-psd-render`. If risk warnings exist,
manually test all affected poses/expressions and relevant clipping and effects.
Check alpha edges on both light and dark editor backgrounds.

If comparison fails, **do not silently export as exact PSD reproduction**.
Use a flattened/rasterized source or explicitly supported alternative layers;
record the deviation in the project-specific diagnostics. An automatic
fallback and guaranteed cross-editor/Photoshop fidelity are later features.
No production claim may rely only on a synthetic-pixel test.

## Practical Phase 0 gate

F-03 can be satisfied by a documented, conservative support boundary plus
repeatable feature-risk reporting. Perfect Photoshop compositing for all PSD
features is deliberately **out of scope**. For untested effects, the correct
status is UNTESTED or unsupported—not PASS.
