"""Start isolated local Finder picker on a separate loopback port."""

import sys

import uvicorn


def main() -> int:
    if sys.platform != "darwin":
        raise RuntimeError("Native Finder picker must run on macOS")
    uvicorn.run("tachie_motion.web.picker_app:app", host="127.0.0.1", port=8766)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
