"""Combined timeline generation from already-produced PCM-containing MOVs."""
import json
from fractions import Fraction
from pathlib import Path
import subprocess
import tempfile
import unicodedata

from tachie_motion.timeline.media import MovieTiming, WaveTiming, probe_movie
from tachie_motion.timeline.otio_json import build_combined_utterances, write_otio
from tachie_motion.web.solo_output import (
    _identity, initial_single_identity, published_media_identity, publish_single, validate_media_basename,
)


def probe_embedded_pcm(movie: Path) -> WaveTiming:
    """Verify an existing MOV has one PCM stream and exact audio sample timing."""
    process = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=codec_name,sample_rate,duration_ts,time_base",
        "-of", "json", str(movie),
    ], capture_output=True, check=False)
    if process.returncode:
        raise RuntimeError("Unable to verify MOV PCM: " +
                           process.stderr.decode("utf-8", "replace")[-1000:])
    try:
        streams = json.loads(process.stdout)["streams"]
        if len(streams) != 1 or not streams[0]["codec_name"].startswith("pcm_"):
            raise ValueError("Expected exactly one uncompressed PCM stream")
        stream = streams[0]
        rate = int(stream["sample_rate"])
        samples = Fraction(int(stream["duration_ts"])) * Fraction(stream["time_base"]) * rate
        if rate <= 0 or samples <= 0 or samples.denominator != 1:
            raise ValueError("PCM sample count is not exact")
        return WaveTiming(int(samples), rate)
    except (KeyError, IndexError, TypeError, ValueError, ZeroDivisionError) as error:
        raise ValueError("Invalid embedded PCM timing") from error


def create_combined_otio(folder: Path, basename: str, entries: list[dict],
                         conflict_policy: str,
                         expected_identities: dict[str, tuple] | None = None,
                         reference_folder: Path | None = None,
                         generation_history: dict | None = None,
                         reused_basenames: set[str] | None = None) -> dict:
    validate_media_basename(basename)
    if not entries or len(entries) > 2000:
        raise ValueError("Combined timeline requires 1–2000 MOV entries")
    target = folder / (basename + ".otio")
    prior = initial_single_identity(target, conflict_policy)
    names: set[str] = set()
    verified = []
    for entry in entries:
        name = validate_media_basename(entry["basename"])
        key = unicodedata.normalize("NFC", name).casefold()
        if key in names:
            raise ValueError("Duplicate media basename")
        names.add(key)
        is_reused = name in (reused_basenames or set())
        if is_reused and reference_folder is None:
            raise ValueError("Reused MOV needs its published folder")
        mov = (reference_folder if is_reused else folder) / (name + ".mov")
        if not mov.is_file() or mov.is_symlink():
            raise ValueError("Missing or unsafe MOV: " + name)
        if expected_identities is not None and published_media_identity(mov) != expected_identities.get(name):
            raise ValueError("MOV does not belong to this batch: " + name)
        movie = probe_movie(mov)
        audio = probe_embedded_pcm(mov)
        if (movie.frames != entry["frames"] or movie.fps != entry["fps"] or
            audio.samples != entry["samples"] or audio.sample_rate != entry["sample_rate"]):
            raise ValueError("MOV has changed since export: " + name)
        info = mov.stat()
        identity = (info.st_dev, info.st_ino, info.st_ctime_ns,
                    info.st_size, info.st_mtime_ns)
        verified.append((mov, movie, audio, identity))

    document = build_combined_utterances([(mov, movie, audio)
                                         for mov, movie, audio, _ in verified])
    if generation_history is not None:
        from tachie_motion.web.selective_reuse import decode_history
        if len(decode_history(generation_history)) != len(entries):
            raise ValueError("Incomplete generation history for combined OTIO")
        document["metadata"]["tachie_motion_selective"] = generation_history
    if reference_folder is not None:
        # Render/verify staged MOVs but refer to final published MOV paths.
        # Both tracks use plain filesystem paths for Resolve compatibility.
        for track in document["tracks"]["children"]:
            for clip, entry in zip(track["children"], entries):
                final = reference_folder / (entry["basename"] + ".mov")
                media = clip["media_references"]["DEFAULT_MEDIA"]
                media["target_url"] = str(final.absolute())
                media["name"] = final.name
    if generation_history is not None:
        from tachie_motion.web.selective_attestation import sign_timeline
        sign_timeline(document)
    with tempfile.TemporaryDirectory(prefix=".tachie-timeline-", dir=folder) as tmp:
        staged = Path(tmp) / "timeline.otio"
        write_otio(document, staged)
        # Reconfirm MOV metadata while exporting: never claim success if a
        # previously rendered source has been replaced in the meantime.
        for mov, timing, audio, identity in verified:
            if mov.is_symlink():
                raise ValueError("MOV became a symlink during export")
            info = mov.stat()
            if (info.st_dev, info.st_ino, info.st_ctime_ns,
                info.st_size, info.st_mtime_ns) != identity:
                raise ValueError("MOV changed during timeline preparation")
            if expected_identities is not None and published_media_identity(mov) != expected_identities.get(mov.stem):
                raise ValueError("MOV was replaced after rendering by this batch")
            if probe_movie(mov) != timing or probe_embedded_pcm(mov) != audio:
                raise ValueError("MOV changed while preparing combined OTIO")
        warning = publish_single(staged, target, policy=conflict_policy, prior=prior)
    result = {"otio": str(target), "entries": len(entries)}
    if warning:
        result["warning"] = warning
    return result
