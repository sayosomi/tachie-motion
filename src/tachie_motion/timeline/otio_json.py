"""Minimum native OpenTimelineIO JSON writer for a one-MOV, one-WAV PoC.

We intentionally avoid a Python 3.14 C++ dependency for this feasibility test.
Official OpenTimelineIO serialization and round-trip validation should replace
this minimal builder when compatible wheels are available.
"""

import json
from pathlib import Path

from tachie_motion.timeline.media import MovieTiming, WaveTiming


def _time(value: int, rate: int) -> dict:
    return {"OTIO_SCHEMA": "RationalTime.1", "value": value, "rate": rate}


def _range(value: int, rate: int) -> dict:
    return {
        "OTIO_SCHEMA": "TimeRange.1",
        "start_time": _time(0, rate),
        "duration": _time(value, rate),
    }


def _clip(name: str, media: Path, units: int, rate: int) -> dict:
    reference = {
        "OTIO_SCHEMA": "ExternalReference.1",
        "name": media.name,
        "metadata": {},
        "available_range": _range(units, rate),
        "available_image_bounds": None,
        "target_url": media.resolve(strict=True).as_uri(),
    }
    return {
        "OTIO_SCHEMA": "Clip.2",
        "name": name,
        "metadata": {},
        "enabled": True,
        "effects": [],
        "markers": [],
        "source_range": _range(units, rate),
        "media_references": {"DEFAULT_MEDIA": reference},
        "active_media_reference_key": "DEFAULT_MEDIA",
    }


def _track(name: str, kind: str, clip: dict) -> dict:
    return {
        "OTIO_SCHEMA": "Track.1",
        "name": name,
        "kind": kind,
        "metadata": {},
        "enabled": True,
        "effects": [],
        "markers": [],
        "source_range": None,
        "children": [clip],
    }


def build_single_utterance(
    mov: Path, wav: Path, movie: MovieTiming, audio: WaveTiming
) -> dict:
    """Create parallel V1/A1 tracks with the same start and exact duration.

    This initial PoC requires identical durations; in production, WAV drives
    the duration and video is explicitly rounded to its frame boundary.
    """
    if movie.duration != audio.duration:
        raise ValueError(
            f"Duration mismatch: MOV={movie.duration}s,"
            f" WAV={audio.duration}s. Use a matching WAV for the PoC."
        )
    video_clip = _clip("Character MOV", mov, movie.frames, movie.fps)
    audio_clip = _clip("Original WAV", wav, audio.samples, audio.sample_rate)
    return {
        "OTIO_SCHEMA": "Timeline.1",
        "name": "tachie-motion sync PoC",
        "metadata": {},
        "global_start_time": _time(0, movie.fps),
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "name": "tracks",
            "metadata": {},
            "enabled": True,
            "effects": [],
            "markers": [],
            "source_range": None,
            "children": [
                _track("V1: character", "Video", video_clip),
                _track("A1: speech", "Audio", audio_clip),
            ],
        },
    }



def build_rounded_utterance(
    mov: Path, wav: Path, movie: MovieTiming, audio: WaveTiming,
    *, embedded_audio: bool = False,
) -> dict:
    """Keep PCM sample-accurate and allow only the final fractional video frame.

    Both media clips start at zero. The MOV gets the exact ceiling frame
    count; the WAV retains its unrounded sample duration. No audio padding or
    duplication is introduced to make the two durations equal.
    """
    if audio.samples <= 0 or audio.sample_rate <= 0:
        raise ValueError("Invalid WAV sample timing")
    if movie.fps not in (24, 30, 60):
        raise ValueError("Unsupported MOV frame rate")
    rounded_frames = (
        audio.samples * movie.fps + audio.sample_rate - 1
    ) // audio.sample_rate
    if movie.frames != rounded_frames:
        raise ValueError("MOV frame count does not match rounded WAV duration")
    video_clip = _clip("Character MOV", mov, movie.frames, movie.fps)
    audio_media = mov if embedded_audio else wav
    audio_clip = _clip(
        "Embedded PCM" if embedded_audio else "Original WAV",
        audio_media, audio.samples, audio.sample_rate,
    )
    # Resolve-on-Mac import verified the original Japanese/NFD WAV only when
    # its OTIO target_url was a filesystem path rather than a percent-encoded
    # file:// URI. Preserve the tested path form on the audio track, including
    # when it references embedded PCM in the same MOV as the video track.
    audio_clip["media_references"]["DEFAULT_MEDIA"]["target_url"] = str(
        audio_media.resolve(strict=True)
    )
    return {
        "OTIO_SCHEMA": "Timeline.1",
        "name": "tachie-motion WAV-driven mouth animation",
        "metadata": {},
        "global_start_time": _time(0, movie.fps),
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "name": "tracks",
            "metadata": {}, "enabled": True,
            "effects": [], "markers": [], "source_range": None,
            "children": [
                _track("V1: character", "Video", video_clip),
                _track("A1: speech", "Audio", audio_clip),
            ],
        },
    }


def write_otio(document: dict, destination: Path) -> None:
    """Save only metadata; do not duplicate any MOV or WAV media bytes."""
    if destination.suffix.lower() != ".otio":
        raise ValueError("Output needs an .otio extension")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation; do not overwrite a previously imported timeline.
    with destination.open("x", encoding="utf-8") as out:
        json.dump(document, out, indent=2, ensure_ascii=False, allow_nan=False)
        out.write("\n")


def _silent_gap(frames: int, fps: int) -> dict:
    """Reserve video-matched time on A1 without creating an audio source."""
    return {
        "OTIO_SCHEMA": "Gap.1",
        "name": "Silent idle",
        "metadata": {},
        "enabled": True,
        "effects": [],
        "markers": [],
        "source_range": _range(frames, fps),
    }


def build_combined_segments(
    entries: list[tuple[Path, MovieTiming, WaveTiming | None]],
) -> dict:
    """Build aligned V1/A1 tracks from utterance MOVs and silent idle MOVs.

    An utterance has sample-accurate embedded PCM. Its final partial video
    frame is trimmed in OTIO only. An idle has no audio media at all: its
    video clip and corresponding audio Gap have the exact same frame duration.
    The source MOV bytes are never edited by this builder.
    """
    if not entries:
        raise ValueError("Combined OTIO needs at least one MOV")
    video_clips = []
    audio_items = []
    for mov, movie, audio in entries:
        if movie.fps not in (24, 30, 60) or movie.frames <= 0:
            raise ValueError("Unsupported or empty MOV frame timing")
        if audio is None:
            video = _clip("Idle MOV", mov, movie.frames, movie.fps)
            video["metadata"]["tachie_motion_segment"] = "idle"
            audio_items.append(_silent_gap(movie.frames, movie.fps))
        else:
            if audio.samples <= 0 or audio.sample_rate <= 0:
                raise ValueError("Invalid PCM sample timing")
            if movie.frames != ((audio.samples * movie.fps + audio.sample_rate - 1)
                                 // audio.sample_rate):
                raise ValueError("MOV frame count does not match PCM duration")
            video = _clip("Character MOV", mov, movie.frames, movie.fps)
            # Keep the encoded final frame in the media, but trim the OTIO
            # video timeline to exact PCM samples so the next item aligns.
            video["source_range"]["duration"] = _time(
                audio.samples, audio.sample_rate)
            audio_clip = _clip("Embedded PCM", mov, audio.samples, audio.sample_rate)
            audio_clip["media_references"]["DEFAULT_MEDIA"]["target_url"] = str(
                mov.resolve(strict=True))
            audio_items.append(audio_clip)

        # Resolve-on-Mac requires ordinary paths for combined OTIO entries.
        video["media_references"]["DEFAULT_MEDIA"]["target_url"] = str(
            mov.resolve(strict=True))
        video_clips.append(video)

    result = {
        "OTIO_SCHEMA": "Timeline.1",
        "name": "tachie-motion combined timeline",
        "metadata": {},
        "global_start_time": _time(0, 30),
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "name": "tracks",
            "metadata": {},
            "enabled": True,
            "effects": [],
            "markers": [],
            "source_range": None,
            "children": [
                _track("V1: character", "Video", video_clips[0]),
                _track("A1: speech", "Audio", audio_items[0]),
            ],
        },
    }
    result["tracks"]["children"][0]["children"] = video_clips
    result["tracks"]["children"][1]["children"] = audio_items
    return result


def build_combined_utterances(
    entries: list[tuple[Path, MovieTiming, WaveTiming]],
) -> dict:
    """Existing utterance-only contract; retained without behavior changes."""
    return build_combined_segments(entries)
