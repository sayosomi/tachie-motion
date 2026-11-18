# Decision log — updated 2026-11-18

These decisions are carried from product planning. Changes require an explicit product decision and docs update.

| ID | Decision |
| --- | --- |
| D01 | Independent editor, not a DaVinci Resolve-specific plugin. |
| D02 | Cross-platform local Web app: macOS and Windows first, Linux-friendly. |
| D03 | React/TypeScript/Vite frontend and Python/FastAPI backend are the initial technical direction. |
| D04 | FFmpeg is installed by the user; do not bundle it initially. |
| D05 | Initial character source is exactly one PSD; preserve its original layer hierarchy/order/names. |
| D06 | No automatic eye/mouth detection. Human manually assigns animation layers. |
| D07 | Expression and pose are combined into **one named preset**. A preset stores per-layer ON/OFF, can be created/duplicated/renamed/deleted/reordered, and only bound lip/blink targets override its base visibility. |
| D08 | One WAV is the primary animation unit, but it may drive several character MOVs (including non-speaking reactions). |
| D09 | Each **WAV × character item** chooses lip mode: none/Open/aiueo. One preset can store the movable Open-open shape and independent aiueo (a/i/u/e/o/ん) definitions. Resting Open-close always uses the preset fixed-layer state; legacy closed data remains saved but inactive (user approved 2026-11-18, Issue #32). None still uses WAV timing/preview. |
| D10 | Blink intervals configurable per character, non-synchronized via phase/random variation, deterministic on rerender; each unified preset can disable eye motion or set multi-layer close eyes. Resting eye-open uses fixed layers; legacy opened data stays saved but inactive (user approved 2026-11-18, Issue #32). |
| D11 | Timeline editing uses change points (not draggable duration clips). |
| D12 | Every WAV/idle item has an independent initial unified preset per character; no implicit inheritance. |
| D13 | Reusable loopable idle MOV library plus special per-scene idle of arbitrary duration. |
| D14 | Export character-sized fixed transparent canvas, consistent across poses/items/rerenders. |
| D15 | Initial media output is ProRes 4444 alpha MOV; 30fps default, configurable 24/60. |
| D16 | **Individual export:** MOV plus per-utterance/per-idle OTIO. **Batch export:** all MOVs plus exactly one combined OTIO (do not also produce individual OTIOs). Approved 2026-11-11, Issue #18. Place each utterance audio **once** on an OTIO audio track referencing the designated PCM-containing MOV; use separate video tracks per character when implemented. In individual single-character OTIO, video and audio refer to the same MOV. Multiple characters from a WAV must not each include duplicate PCM; idle MOVs have no audio. |
| D17 | **Do not copy or bundle source WAVs in any export**, including portable output. Embed the input WAV-derived lossless integer PCM in the designated utterance MOV, preserving the source WAV unchanged. OTIOs reuse generated MOV media without duplication. The legacy standalone `tachie-otio-poc` remains a separate compatibility PoC, not the production media-output contract. |
| D18 | Separate reusable character profile from project file; snapshot used settings; rerender changed MOV only. |
| D19 | Private during early development, public OSS release is the long-term aim; license not yet selected. |
| D20 | Local Web UI runs **on demand, in the foreground** with `tachie-web` and stops with `Ctrl+C`; no auto-start, persistent web daemon/launchd or `nohup` by default. The backend remains bound to `127.0.0.1`. Remote Android access may use **Tailscale Serve (tailnet-only HTTPS)** on a separate port 8443 to loopback 8765, without altering an existing Voiceger Serve on 443; the browser-facing origin is explicitly allowlisted with `TACHIE_TAILSCALE_ORIGIN` and checked by Host/Origin validation. Serve is started/stopped on demand for the session; never use Funnel or bind the backend to a LAN/Tailscale address. SSH local port forwarding remains a supported alternative. |
| D21 | Character setup top page lists presets with previews; each preset has a dedicated detail page. Presets support duplication, free renaming, deletion and drag-and-drop reordering; stable internal IDs preserve references. |
| D22 | Each PSD layer in the base preset has only ON/OFF. Mouth and eye states can comprise several layers together. The dynamic renderer may override **only** the respective target layers. |
| D26 | 2026-11-17: Use **original PSD layer groups** as the unit of animation targeting; multiple groups may feed one action's independent leaf-level shapes. Keep **fixed** and **movable** PSD trees separate in the editor. Group bindings are character-wide, while mouth/blink motion can be disabled per unified preset without deleting shape settings. A hidden parent always hides its children. One PSD group cannot be assigned to competing animations in the initial UI. Preserve optional PSDTool name prefixes as controls: `*` is an exclusive radio within the same immediate PSD parent; `!` is mandatory visible. Plain names stay ordinary checkboxes. |
| D25 | Batch overwrite is a whole-generation operation: stage/validate all PCM ProRes MOVs and one combined OTIO first, retain a durable manifest plus hardlinked originals until all names are published, and restore all originals on ordinary failure. Interrupted publication leaves a manually recoverable backup and blocks future writes until inspected. Users can instead choose one common suffix for the entire new generation (Issue #18, approved 2026-11-14). |
| D24 | The only naming placeholders are `{番号}` (WAV-list order, padded to 3 digits), `{WAV名}` (source WAV stem), `{キャラ名}`, `{プロジェクト名}`. MOV default `{番号}_{キャラ名}_{WAV名}`; batch OTIO default `{プロジェクト名}`. File extensions are automatic and actual resolved filenames must be shown before exporting (Issue #18, approved 2026-11-11). |
| D23 | aiueo has six defined mouth shapes: a/i/u/e/o/ん, with ん used as silent/rest mouth. WAV selection probes an exact sibling .lab path preserving original filename characters; a missing/invalid LAB disables aiueo, without inferred phonemes or automatic mode fallback. The n rest can be explicitly marked as inheriting the fixed-layer pose in an optional v1 profile field; missing legacy markers still inherit base. |
| D27 | **2026-11-17 user-approved aiueo MOV rule:** sample the center of each video frame in WAV sample-time using exact integers, clamping the last partial frame to an actual PCM sample; map consonants to the **next LAB vowel** (including vowels shorter than one video frame) until a silence, gap or moraic nasal N; use ん if no next vowel. Uppercase devoiced A/I/U/E/O use their lowercase vowel shape. LAB pause/silence/N/gaps use ん, with no inferred phonemes or Open fallback. |

## Unresolved decisions / validation

- Public OSS license, attribution, trademark/project identity.
- Exact package/distribution method for Python backend; FFmpeg external.
- Parent visibility follows the source PSD (D26). Precedence and conflict handling when mouth/eye targets overlap remain unresolved; do not infer a priority.
- Deletion behavior for presets referenced by project snapshots, and precise migration policy for earlier single-layer bindings.
- Absolute vs relative media-link behavior per OTIO importer; verification required.
- **2026-11-06 decision, Issue #2:** WAV-derived non-compressed PCM in utterance MOV is the agreed output contract; do **not** offer WAV copying, even as an optional portable-output feature. Mac DaVinci Resolve standalone MOV and individual OTIO Human E2E PASS; independent code review and synthetic CI PASS were recorded separately. Combined OTIO / multi-character behavior remains planned, including selection of the single audio-owner MOV when multiple characters or no speaker image is rendered; do not describe the future workflow as implemented.
- PSD compositing fidelity boundaries and fallback/error presentation.
- Exact idle looping rules with blinking and whether loopable motion must be periodic by construction.
- Default output pixel scaling, preset migration rules and project schema versioning.

Do not silently resolve any of these as if already user-approved.
