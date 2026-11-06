# Architecture proposal

Status: architecture boundaries include both implemented and proposed features. The Phase 0/1 Python CLI and initial local Web UI/API are implemented, while timeline/project editing remains planned. See [README](../README.md) for usable commands and [ROADMAP](ROADMAP.md) for progress.

## System

- Frontend: React + TypeScript + Vite. PSD tree, preview, WAV list, change-point timeline.
- Local API: Python + FastAPI. Project model, file selection, analysis/render job control.
- Core Python modules: psd-tools (PSD read), Pillow/NumPy (compositing, waveform), LAB parser, animation state evaluator, OTIO exporter.
- Video: installed FFmpeg CLI invoked with array arguments. Verify prores_ks/profile 4444/pixel format and alpha using ffprobe.
  - Optional repeated-hold optimization (`reuse_packets=True`, CLI `--reuse-packets`) encodes each source state once, then uses exact-timestamp ProRes key-packet stream copy. This option is disabled by default; unsupported conditions fall back to the original raw-frame encoder. The finished output is accepted only after packet SHA256/timestamp checks and the unchanged `inspect_prores()` all-frame decoded fidelity gate; on failed integrity checks no MOV is published. The optimization is intentionally opt-in; platform compatibility beyond tested environments remains a validation concern.
- Distribution: build frontend statically; serve from local backend. Bundling Python is undecided. FFmpeg is external.
- Local network: listen on loopback (127.0.0.1), not LAN by default. Protect file system operations and mutating API routes against unwanted origins.

## Data and rendering boundaries

1. PSD source: enumerate original tree, order and visibility; create stable in-project identities even when duplicate names exist. No automatic semantic classification.
2. Character profile: PSD reference, manual lip/eye bindings, presets, blink configuration, fixed canvas bounds, stable origin.
3. Animation item: WAV or idle, independent initial presets, timestamped change points, lip mode, blink seed. No inheritance across items.
4. Pure evaluator: (item, time) -> effective layer visibility and transforms. Preset first; only explicitly bound eyes/mouth are overridden.
5. Renderer: cache repeated combinations; composite transparent RGBA frames with consistent pixel/alpha/color treatment.
6. Encoder: stream frames to FFmpeg; export alpha ProRes 4444 MOV. Decode/reinspect rendered output for verification.
7. Timeline: OTIO tracks containing MOV refs by character and one WAV ref per utterance, with explicit gaps for idle or absent characters.

## Module boundaries (anti-monolith)

Keep the interfaces small and independently testable; these are responsibility boundaries, not mandatory filenames:

- `frontend/src/features/psd/`: layer tree and visibility controls.
- `frontend/src/features/animation/`: preview, waveform and change-point timeline.
- `frontend/src/features/characters/`: presets, manual mouth/eye mappings and blink settings.
- `backend/api/`: thin HTTP endpoints and validation; no PSD or FFmpeg algorithms.
- `backend/domain/`: immutable character/item models, preset resolution and time/state evaluation.
- `backend/psd/`: reading PSD trees and composing layers.
- `backend/audio/`: WAV features and LAB parsing.
- `backend/render/`: canvas bounds, RGBA frame production and FFmpeg invocation (separate modules).
- `backend/timeline/`: OTIO model/export and media path rules.

Enforce the small-file review guidelines in [AGENTS.md](../AGENTS.md). Directory names may be adjusted after the PoC; do not introduce empty scaffolding merely to match this list.

## Timing and determinism

- Use integer samples, frame indices, or rational time representations to avoid floating-point drift.
- Segment durations derived from WAV; rounded video frames must not push later audio out of sync.
- Preserve stable media names and geometry on partial rerender.
- Blink random state is derived from stored per-character/per-item seed and timing parameters.
- Still frames or facial states may be cached; reference frame compositing must be deterministic.

## Initial proof-of-concept risks

- PSD effects/blend modes/clipping/masks/adjustments may not match Photoshop's appearance. Test against a genuine PSD and documented reference image.
- RGBA-to-ProRes alpha can exhibit fringe, incorrect alpha interpretation or wrong channel order. Verify transparency in Resolve and via frame decode.
- OTIO imports vary across editors. Test real DaVinci Resolve import, multi-video tracks, WAV sync and media relinking before claiming compatibility.
- Frozen canvas must include possible sprite bounds while keeping character anchor stable.
- Windows installation and FFmpeg discovery differ from macOS; test CI and manual smoke runs early.

## Diagnostics and tests

- Separate pure unit tests from renderer/encoder integration tests and Playwright E2E tests.
- Track application build, media hash/metadata (not private bytes), FFmpeg version, render options and failures.
- No background upload of private media. No source audio/PSD or generated MOV committed by default.
