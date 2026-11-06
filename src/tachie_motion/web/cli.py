"""Launch the local browser UI on loopback, never on LAN."""

import argparse

import uvicorn


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the local tachie-motion web UI.")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535")
    print(f"Open http://127.0.0.1:{args.port}/ in a browser.")
    uvicorn.run("tachie_motion.web.app:app", host="127.0.0.1", port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
