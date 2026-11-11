"""Project-file source identity: WAV changes must not be silently accepted."""

import wave

import pytest

from tachie_motion.web import service


def wav_fixture(tmp_path):
    path = tmp_path / "音声 e\u0301.wav"
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(48000)
        writer.writeframes(b"\x00\x00" * 480)
    return path


def test_describe_wav_has_full_source_identity(tmp_path):
    path = wav_fixture(tmp_path)
    info = service.describe_wav(str(path))
    assert info["samples"] == 480
    assert info["sample_rate"] == 48000
    assert len(info["source_identity"].split(":")) == 5
    assert info["source_identity"] == ":".join(
        map(str, service.file_identity(path))
    )
    assert service.describe_wav(str(path))["source_identity"] == info["source_identity"]


def test_changed_source_during_wav_inspection_is_rejected(tmp_path, monkeypatch):
    path = wav_fixture(tmp_path)
    first = (1, 2, 3, 4, 5)
    second = (1, 2, 4, 4, 5)
    identities = iter((first, second))
    monkeypatch.setattr(service, "file_identity", lambda _: next(identities))
    with pytest.raises(ValueError, match="changed during inspection"):
        service.describe_wav(str(path))
