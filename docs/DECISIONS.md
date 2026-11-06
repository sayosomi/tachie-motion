# Decision log — updated 2026-10-31

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
| D09 | Each **WAV × character item** chooses lip mode: none/open/aiueo. One preset can independently store both optional open (closed/open mouth) and aiueo (a/i/u/e/o/ん) mouth definitions; it is not duplicated per mode. None still uses WAV timing/preview. |
| D10 | Blink intervals configurable per character, non-synchronized via phase/random variation, deterministic on rerender; each unified preset may disable blinking or provide multi-layer open/closed eye states. |
| D11 | Timeline editing uses change points (not draggable duration clips). |
| D12 | Every WAV/idle item has an independent initial unified preset per character; no implicit inheritance. |
| D13 | Reusable loopable idle MOV library plus special per-scene idle of arbitrary duration. |
| D14 | Export character-sized fixed transparent canvas, consistent across poses/items/rerenders. |
| D15 | Initial media output is ProRes 4444 alpha MOV; 30fps default, configurable 24/60. |
| D16 | Export both combined OTIO and per-utterance/per-idle OTIO; one WAV reference per utterance, MOV tracks by character. |
| D17 | Copy original WAV without modification to portable media output; do not duplicate media for every OTIO. |
| D18 | Separate reusable character profile from project file; snapshot used settings; rerender changed MOV only. |
| D19 | Private during early development, public OSS release is the long-term aim; license not yet selected. |
| D20 | Local Web UI runs **on demand, in the foreground** with `tachie-web` and stops with `Ctrl+C`; no auto-start, persistent web daemon/launchd or `nohup` by default. The backend remains bound to `127.0.0.1`. Remote Android access may use **Tailscale Serve (tailnet-only HTTPS)** on a separate port 8443 to loopback 8765, without altering an existing Voiceger Serve on 443; the browser-facing origin is explicitly allowlisted with `TACHIE_TAILSCALE_ORIGIN` and checked by Host/Origin validation. Serve is started/stopped on demand for the session; never use Funnel or bind the backend to a LAN/Tailscale address. SSH local port forwarding remains a supported alternative. |
| D21 | Character setup top page lists presets with previews; each preset has a dedicated detail page. Presets support duplication, free renaming, deletion and drag-and-drop reordering; stable internal IDs preserve references. |
| D22 | Each PSD layer in the base preset has only ON/OFF. Mouth and eye states can comprise several layers together. The dynamic renderer may override **only** the respective target layers. |
| D23 | aiueo has six defined mouth shapes: a/i/u/e/o/ん, with ん used as silent/rest mouth. WAV selection probes an exact sibling .lab path preserving original filename characters; a missing/invalid LAB disables aiueo, without inferred phonemes or automatic mode fallback. |

## Unresolved decisions / validation

- Public OSS license, attribution, trademark/project identity.
- Exact package/distribution method for Python backend; FFmpeg external.
- Parent/group effective visibility, precedence and conflict handling when mouth/eye dynamic targets overlap; not decided merely by agreeing to the two-state preset UI.
- Deletion behavior for presets referenced by project snapshots, and precise migration policy for earlier single-layer bindings.
- Absolute vs relative media-link behavior per OTIO importer; verification required.
- PSD compositing fidelity boundaries and fallback/error presentation.
- Exact idle looping rules with blinking and whether loopable motion must be periodic by construction.
- Default output pixel scaling, preset migration rules and project schema versioning.

Do not silently resolve any of these as if already user-approved.
