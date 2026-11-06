"""Mac-only native Finder dialogs. No browser uploads or arbitrary path listing."""

from pathlib import Path
import subprocess
import sys
from typing import Literal

PickerKind = Literal["psd", "wav", "output_dir"]


class PickerUnavailable(RuntimeError):
    """The operating system could not present a selection dialog."""


_DIALOGS = {
    "psd": ('file', 'PSDファイルを選択'),
    "wav": ('file', 'WAVファイルを選択'),
    "output_dir": ('folder', '書き出し先を選択'),
}


def _picker_script(kind: PickerKind, *, multiple: bool = False) -> str:
    operation, prompt = _DIALOGS[kind]
    command = f'choose {operation} with prompt "{prompt}"'
    if multiple:
        command += " with multiple selections allowed"
    result = (
        "    set chosenPaths to {}\n"
        "    repeat with chosenFile in chosen\n"
        "        set end of chosenPaths to POSIX path of chosenFile\n"
        "    end repeat\n"
        "    set AppleScript's text item delimiters to (ASCII character 0)\n"
        "    return chosenPaths as text\n"
    ) if multiple else "    return POSIX path of chosen\n"
    # Directory is an argv value, never spliced into AppleScript source.
    return (
        "on run argv\n"
        "    if (count of argv) > 0 then\n"
        "        set startFolder to (POSIX file (item 1 of argv)) as alias\n"
        f"        set chosen to {command} default location startFolder\n"
        "    else\n"
        f"        set chosen to {command}\n"
        "    end if\n"
        + result
        + "end run"
    )


def choose_local_source(
    kind: PickerKind, *, initial_dir: str | None = None, multiple: bool = False,
) -> dict[str, str | list[str]]:
    """Return an exact local POSIX path, or a cancellation result.

    This function is intentionally not exported through the main Web API.
    The dedicated loopback-only picker server performs request authorization.
    """
    if kind not in _DIALOGS:
        raise ValueError("Unknown picker kind")
    if multiple and kind != "wav":
        raise ValueError("Multiple selection is supported for WAV files only")
    if sys.platform != "darwin":
        raise PickerUnavailable("Finder selection is available on macOS only")

    # A previously used folder may have been moved, unmounted or deleted.
    # In that case open the ordinary dialog rather than failing the selection.
    args = ["osascript", "-e", _picker_script(kind, multiple=multiple)]
    if isinstance(initial_dir, str) and 0 < len(initial_dir) <= 4096:
        folder = Path(initial_dir)
        try:
            if folder.is_absolute() and folder.is_dir():
                args.append(initial_dir)
        except (OSError, ValueError):
            pass
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=300, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PickerUnavailable("Finder selection failed or timed out") from exc
    if result.returncode != 0:
        if "(-128)" in result.stderr or "User canceled" in result.stderr:
            return {"status": "cancelled"}
        raise PickerUnavailable("Finder could not open a file selection dialog")
    # osascript adds one terminal newline. Do not strip whitespace from a
    # legitimate filename; never normalize Japanese or combining characters.
    source = result.stdout.removesuffix("\n")
    paths = source.split("\0") if multiple else [source]
    if not paths or len(paths) > 256:
        raise PickerUnavailable("Invalid number of WAV selections")
    for path in paths:
        if not path or not Path(path).is_absolute():
            raise PickerUnavailable("Finder returned an invalid path")
        selected = Path(path)
        if kind == "output_dir":
            if not selected.is_dir():
                raise PickerUnavailable("The chosen directory no longer exists")
        elif selected.suffix.lower() != "." + kind or not selected.is_file():
            raise PickerUnavailable("The selected file has the wrong type or is missing")
    if multiple:
        return {"status": "selected", "paths": paths}
    return {"status": "selected", "path": source}
