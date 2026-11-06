# PC-first UI architecture and local file selection (working design)

Status: implementation design recorded 2026-11-01. This is **not** an amendment to agreed `docs/PRODUCT_SPEC.md` or a declaration that features are implemented. Confirmed requirements remain in PRODUCT_SPEC/DECISIONS. Unresolved behavior must remain unresolved until agreed.

## Primary user environment / principles

- **Mac desktop Chrome is the primary UI.** Windows desktop is the second target. Android/Tailscale is optional remote verification, not the basis for desktop layout or file selection.
- **No absolute-path typing in the normal workflow.** Finder/Explorer picker buttons are the default, with explicit advanced path entry only as a fallback. See Issue #20.
- Preserve original PSD, WAV, LAB (no auto rename, upload, overwrite, or copy by default); FFmpeg remains user installed. Preserve exact Unicode and the user's storage paths.
- PSD and character setup must be reusable separately from a project. A project stores a snapshot rather than silently picking up later profile edits.
- Avoid temporary UI stages becoming the permanent navigation. The PR #38 one-WAV `セリフ` screen is an incremental capability, **not** the approved final information architecture.
- The current browser localStorage preset draft is crash/reload recovery, **not** the permanent character/project storage format.

## Proposed information architecture (desktop)

Global header: **プロジェクト名** / 開く / 保存, current workspace, explicit export status.

| Workspace | Main content | Detail interaction |
| --- | --- | --- |
| **キャラクター** | Character selection, PSD source, named preset gallery with thumbnails, default preset | Clicking a preset opens its dedicated detail editor: base PSD layer ON/OFF, optional open/aiueo mouth states, optional eye states/blink, preview. Preserve separate pages per confirmed spec. |
| **編集** | Ordered WAV and idle items, audio waveform and playhead, per-item character lanes, change points | Selected WAV×character has initial preset, lip mode none/open/aiueo, LAB association and validation, plus editable change points. Right-side item inspector; preview is synchronized. |
| **書き出し** | Target folder, format/fps, output selection and status | Generate per-character MOVs, individual and combined OTIO, validate before publication, reuse unchanged outputs according to confirmed spec. |

The desktop editing work area is designed from **asset/item list + central waveform/timeline + contextual inspector + character preview**. Layout may adapt to window width without overlapping media and controls. An item selection changes inspector content; it must not create redundant top-level screens.

The project-level navigation above does **not** redefine the agreed character preset top page / separate preset detail page. Do not add permanent top navigation for every implementation slice (e.g. standalone mouth exporter, one-WAV experiment). Do not expose incomplete output modes as available.

## Canonical data model and state boundaries

- **CharacterProfile** (Issue #44 initial versioned JSON): one original PSD path plus lightweight fingerprint/index-path snapshot matching, stable preset IDs, ordered presets, default ID, each preset's complete base ON/OFF and optional multi-layer mouth/eye states, character blink flags. Source-relinking and project snapshots remain future work.
- **Project** (future versioned JSON): reusable character profile snapshots, ordered WAV/idle items, exact source references, character assignments, chosen lip mode per WAV×character, independent initial preset and change points, output fps/path settings and deterministic blink seed.
- **Rendering input** must be a validated project/item **snapshot**, not a mutable React component or the currently visible PSD layer state. UI is an editor of these models; the backend is responsible for authoritative validation/encoding.
- Missing/changed assets must prompt the user to reselect a source; never silently associate another file or overwrite it.
- `localStorage` remains a best-effort recovery copy of the current editing draft until real profile/project save exists. No claim that it provides cross-browser persistence.

## Native file selection contract (Issue #20)

**Mac first, only from the Mac's interactive desktop session:** use a small backend OS-dialog adapter (e.g. `osascript` `choose file` and `choose folder`) to return the chosen **existing local** file/folder path. Do not turn this into a browsing API that lists arbitrary directories.

- Supported picker intents: `psd`, `wav` (multi-select when the WAV list exists), `output_directory`; this should be one backend adapter API with platform implementations rather than separate picker logic per screen.
- Return a path/reference to the backend's existing `local_file` validation. Treat any selected path as untrusted; verify file type, existence, symlinks, caps, and race conditions. Preserve exact Japanese/space/NFD characters.
- Picker cancellation is a normal state: leave existing selection and unsaved edits unchanged. Any OS dialog error must be visible, never replaced with a sample path.
- **Local Mac UI only:** remote/Tailscale browser calls must not be able to invoke Finder dialogs or enumerate local paths. Security review must address the reverse-proxy threat model, CSRF, Host/Origin and how local-only invocation is enforced; an Origin header check alone is not proof of local presence.
- Windows requires a separate Explorer-native adapter and separate validation. Never label Windows picker PASS based on Mac.
- Browser `<input type=file>` / browser File System Access APIs do not expose the original absolute path to JavaScript. They are **not** substitutes for this direct-local-reference contract. Do not silently upload PSD/WAV as a file transfer.
- Drag/drop from Finder is a desired UX but cannot be made equivalent to direct path selection in a plain browser without a trusted native bridge. Explore that separately after the native picker; do not pretend a browser File object provides an original path.
- Manual absolute path input may remain under an **advanced** disclosure for headless/manual recovery, not as a required normal step.
- Output folder is selected using a folder picker; do not create or overwrite unrelated destinations.

## UI implementation sequence / completion gates

1. **PR #37 / Issue #35**: correct desktop preset card layout and run wide-viewport geometry/screenshot regression tests.
2. **Design integration**: shared navigation/layout shell, stable item and profile identifiers, boundaries between UI state and saved data. This document records direction, not a PASS.
3. **Issue #20**: a safe Mac native picker for PSD/WAV/output folder. Mock system dialogs in automation; explicitly review security and failure/cancel behavior. Mac Human check separate.
4. **Issue #23**: complete optional open + aiueo + blink state editors and preview consistent with the eventual renderer. Do not decide hidden parents or overlapping mouth/eye overrides without product decision.
5. **Issue #36**: build item list, LAB verification, per WAV×character mode and preset references, waveform/playhead/change points, idle items incrementally, then exporter and combined/individual OTIO. No repeated legacy exporter Human E2E.
6. Versioned character/project file persistence, independent engine tests and new-path Resolve validation. Reuse completed components; do not duplicate renderer logic in frontend.

### Minimum test gates for affected PRs

- PC Chrome widths: 1100, 1440, 1920, 2560; single/multiple preset cards; no overlap, horizontal scroll or inaccessible buttons.
- File chooser: success, user cancel, invalid extensions, missing/renamed/moved files, symlinks, NFD/Japanese/space paths, concurrent dialogs, and remote request denied without an OS prompt.
- Source material bytes unchanged; no upload or Git addition; CLI/GUI rendering contracts remain aligned.
- Different workflows/presets/WAV items cannot silently share or overwrite state; browser reload uses validated snapshot.
- Explicit differentiation: synthetic tests, Playwright, local Mac human UI, Mac Resolve. No PASS claims for unexecuted stages.

## Current status and source of truth

PR #37 changes layout. PR #38 introduces a narrow one-WAV none/open draft export; it does **not** satisfy the full spec or the proposed project-level navigation. The experimental old export tab must not be used for new Human tests. The layout and native-picker design do not require any change to the confirmed product requirements in PRODUCT_SPEC or DECISIONS.

Tracking: Issue #20 (picker); Issue #23 (presets); Issue #35 / PR #37 (PC layout); Issue #36 / PR #38 (new export). Future PRs must update README and ROADMAP when real capabilities or operation change.

## Initial Finder picker slice (Issue #20 / PR #39)

- A separately bound picker service on 127.0.0.1:8766 is **never registered with Tailscale Serve** (the Android forwarder only targets 127.0.0.1:8765). Local Mac browser origin must be exactly 127.0.0.1:8765 or localhost:8765 and the picker request must have explicit Host/Origin, custom header and JSON preflight guards. The normal app has no native dialog routes.
- `scripts/run_mac_web.py` is on-demand foreground supervisor and owns only its Web and picker children. `tachie-web` and `scripts/run_android_web.py` remain unchanged; Android browser never uses Finder dialogs.
- Finder native selection is available for PSD, WAV and output folder; path textbox is disclosed only as an advanced fallback. Browser uploads and Finder drag/drop are deliberately not substituted for local source references.
- The Mac Finder picker is implemented on main and uses the separate loopback-only 8766 sidecar. Mac user-visible picker flow and descendant PR #39 exact-head CI were verified. Windows Explorer support remains unimplemented; remote Android must not access the local picker. Security review, test results and Human acceptance refer to their recorded exact HEADs; do not treat these gates as interchangeable.


## User-approved role-column refinement (Issue #40; 2026-11-01)

The **same original hierarchical PSD layer list** is used for base preset ON/OFF and per-leaf mouth/eye role assignment, rather than making the user locate mouth layers a second time. Left checkbox = base ON/OFF. The redundant plain-text ON/OFF badge is removed; the freed right edge carries a role selector. Group rows remain structural; index paths disambiguate duplicate names. Search/expand/assigned-only serve large PSDs.

A unified preset stores exactly **one Open closed shape and one Open opened shape**, each possibly made from several PSD leaves. The Open column offers `—` / `閉じ口` / `開き口`: a non-target stays under its base visibility; a role overrides only that leaf in the active mouth shape. Its rendered image can be previewed through validated PSD compositing without modifying the source. Existing arbitrary `closed/opened` visibility pairs must be preserved, not silently collapsed into a role when the three-way vocabulary cannot represent them.

The same *column slot* will later switch between mode tabs Open (closed/open), aiueo (a/i/u/e/o/ん), and eyes/blink (opened/closed eye). **Only Open is implemented in the Issue #40 slice; other tabs are disabled and labelled until backed by validated model and render support.** This does not approve any new eye/mouth conflict priority or hidden-parent coercion.

Per-WAV×character Open movement response/threshold controls belong in a separate Edit inspector beside waveform/preview and are not baked into the artwork role. Future smoothing, minimum hold, timing offset, and character defaults versus per-item overrides require separate concrete decisions. The original one-PSD-per-character product contract, multi-character project architecture, PC tile gallery, and exporter safety are unchanged.


### Preview usability refinement (Issue #40, Mac Human observation)

The initial Mac 1500×3300 PSD screenshot showed only the top of the character, hiding the mouth; the in-place role editor itself was otherwise provisionally acceptable. The preview is a fixed full-canvas read-only bitmap, fitted without implicit grid image sizing, with client-only zoom, pan, reset and mouth-target focus using known PSD layer bounding boxes. Base/closed/open image switching preserves the chosen viewport. Do not crop or change renderer/output coordinates. Later aiueo/eye preview can reuse the same viewport component; its unimplemented role editor remains disabled. Authentic Mac mouth visibility is a separate Human recheck.
