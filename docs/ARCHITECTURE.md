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
3. Animation item: the current product supports one character's WAV utterances with independent initial presets and PCM-position change points. Under the approved **future** multi-character workflow (Issues #67–#74), a WAV drives animated MOVs for the speaker and listeners; listeners may blink/change preset but do not lip-sync. After each WAV (including the last), waiting is represented by a **static transparent PNG** chosen from that character's preset, with project-wide wait seconds and FPS. Wait PNGs do not animate or have preset change points; the separate idle MOV with optional blinking is a superseded draft design (PRs #56/#58/#65, not merged). Blink timings for animated MOVs are character-wide; a stored legacy seed may remain but does not control export.
4. Pure evaluator: (item, time) -> effective layer visibility and transforms. Preset first; only explicitly bound eyes/mouth are overridden.
5. Renderer: cache repeated combinations; composite transparent RGBA frames with consistent pixel/alpha/color treatment.
6. Encoder: stream frames to FFmpeg; export alpha ProRes 4444 MOV. Decode/reinspect rendered output for verification.
7. Timeline: **Currently**, a single utterance exports only its PCM-containing MOV (no individual OTIO), and a one-character batch exports MOVs plus one combined OTIO. **Planned** multi-character output has a separate video track per character, a single shared audio timeline, and static-PNG waiting clips after each WAV; audio from a speaker's WAV belongs only to that speaker's MOV, while no-character WAVs are referenced directly once in the OTIO without copying. These later features are not implemented in this PoC. See PRODUCT_SPEC for the approved contract.

## Selective utterance MOV reuse (Draft PR #63 / Issue #62)

Generation history resides in `metadata.tachie_motion_selective` inside the published combined OTIO, not the editable project JSON. A private per-user key at `~/.tachie-motion/reuse-history-v1.key` authenticates the *complete* OTIO document (manifest and both media tracks) using HMAC-SHA256. The key is not embedded in OTIO/MOV or copied into the export folder. A missing, altered, or differently provisioned key fails closed, forcing regeneration on a new installation. This does not protect against malicious code running with the same user's home-directory access. Each stable utterance ID maps to its published basename, SHA256 of an explicit-version render recipe, SHA256 of the published MOV and exact video/PCM timing. Original PSD/WAV/required LAB are hashed as regular files; the recipe includes effective visibility, mouth/eye, change points, blink settings and fps. Order/output path/conflict/session tokens are excluded. Renderer behavior changes must bump the explicit recipe revision.

The reuse candidate endpoint is read-only and advisory. Batch-start validates file names, original destinations and prior OTIO metadata. Each MOV request rechecks the requested item against the saved history, current source identity and bytes, current render recipe, the public MOV digest and independent video/PCM probes. Failure never silently authorizes reuse. The batch coordinator holds per-item identities; only new/dirty MOVs enter the private stage and publication set. The combined OTIO reads untouched public MOVs alongside staged dirty MOVs, but always writes final public paths into both media tracks. The whole-generation publisher still transactionally guards changed MOVs and the OTIO; reuse does not replace, rename, hardlink or republish the existing public MOV. Reorder-only batches publish the OTIO alone.

The output-name exception is approved D31: a verified existing MOV retains its historical public basename even if its original `{番号}` no longer matches the current WAV order. The UI presents the effective old filename and suggested new automatic filename separately. Name collisions fail closed. The initial scope is a single character and multiple utterance WAVs; `別名で保存` intentionally creates a fully new generation. A previously published timeline lacking valid history cannot grant reuse. Final CI/remote review/Mac Human/Resolve gates are separate and still required before merge.

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
- Blink timing parameters (interval, closed duration, jitter and first-blink phase) are persisted per character. Each utterance MOV export draws fresh randomness for its first blink and subsequent intervals; the stored legacy seed is ignored. Re-exporting the same WAV need not reproduce its blink timing. The pure frame scheduler remains deterministic when given explicit parameters and seed, enabling exact automated tests.
- Still frames or facial states may be cached; reference frame compositing must be deterministic.

## Initial proof-of-concept risks

- PSD effects/blend modes/clipping/masks/adjustments may not match Photoshop's appearance. Test against a genuine PSD and documented reference image.
- RGBA-to-ProRes alpha can exhibit fringe, incorrect alpha interpretation or wrong channel order. Verify transparency in Resolve and via frame decode.
- OTIO imports vary across editors. Test real DaVinci Resolve import, multi-video tracks, WAV sync and media relinking before claiming compatibility.
- Frozen canvas must include possible sprite bounds while keeping character anchor stable.
- Windows installation and FFmpeg discovery differ from macOS; test CI and manual smoke runs early.

## Live export progress and cancellation (Issue #44)

- 新規進捗予約APIは短時間だけ `export_lock` を取得し、既存バッチのアイドル失効判定後に進捗ジョブを予約する。実worker稼働中は誤って失効させない。旧タブのトークンを失った新規ブラウザでも10分失効後に新しい予約が可能。
- 一括開始の事前検証失敗は、未起動の同一トークン予約だけ終了する。公開に成功した一括処理は、その後の不要な解除HTTPの失敗で結果を覆さない。単一のPOST通信断と進捗成功ポーリングが逆順でも、終端を確認した編集ロックは解除する。


- `web/export_progress.py` owns a thread-safe in-memory, unguessable job-token registry independent of the media `export_lock`; a read-only progress endpoint and a cancellable request endpoint can respond while a long-running `asyncio.to_thread` render holds the export lock. Tokens do not embed private media paths.
- `render/sequence.py` signals successfully submitted FFmpeg frames. `render/cancel_monitor.py` watches the worker's cancellation token across blocking FFmpeg input writes, encoder waits, ffprobe metadata/packet checks, ProRes frame decode and PCM decode; the child is killed and reaped before a cancelled operation is reported. PSD image compositing remains cooperative between poses. The output's existing full-frame ProRes and PCM fidelity gates remain unchanged.
- The percent is a monotone stage-completion indicator, not elapsed-time extrapolation. Single export reaches 100% only after a public MOV commit. Batch MOVs enter a private stage and consume at most 90%; the remaining percentage covers combined OTIO and generation-wide publication. Public batch commit is a non-cancellable transaction protected by rollback.
- A browser close/disconnect never proves backend termination or success. Avoid claiming cancellation on request acceptance alone; the server reports explicit running/cancelling/finalizing/success/failed/cancelled states.
- Browser exports register a UUIDv4 with the progress registry **before** posting media work, making pre-start cancellation atomic and preventing a cancelled render from later starting. Terminal snapshots remain queryable for up to one hour across subsequent jobs. The batch coordinator notifies progress when its 10-minute idle lease expires, always under the media export lock. A disconnected batch client retains its editing lock while awaiting the authoritative terminal state; a cancellation request is finalized by the server after any in-flight worker exits. Session-scoped browser storage restores the progress ID after same-tab reload; no render or publish is inferred from a lost HTTP response.

## Diagnostics and tests

- Separate pure unit tests from renderer/encoder integration tests and Playwright E2E tests.
- Track application build, media hash/metadata (not private bytes), FFmpeg version, render options and failures.
- Solo MOV overwrite uses Linux `renameat2(RENAME_NOREPLACE)` or macOS `renamex_np(RENAME_EXCL)` for non-replacing, atomic isolation; unsupported filesystems fail closed. Never use check-then-unlink to remove a shared pathname. Retain older MOV generations in hidden manual-cleanup archives (not automatic recovery blockers), so repeated overwrites consume storage until the user reviews and deletes them. Interrupted recovery remains blocking. This guarantee does not cover concurrent mutation of the contents of an already-open inode.
- No background upload of private media. No source audio/PSD or generated MOV committed by default.

## Issue #49: per-WAV preset change points (Draft PR #50)

The utterance owns its sample-position change points and initial stable preset ID. The
front-end uses `presetChangePoints.ts` for immutable edits and exact frame-center
conversion, and `projectFile.ts` validates the JSON v4 list against WAV sample count
and the character snapshot's preset IDs. The existing single and batch paths share
`exportPayload`. The Python domain module `preset_timeline.py` validates sample
boundaries; `preset_timeline_render.py` composes complete preset states on the
PSD-wide fixed crop. Rendering/PCM mux/ProRes verification and publication remain
owned by the existing writer. v3 project files are not silently migrated.
These are Draft changes until independently validated and merged.
