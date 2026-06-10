#!/usr/bin/env python3
"""Small static server for running the WIFITEST frontend without Tauri."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


class WifitestFrontendHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, project_root: Path, **kwargs):
        self.project_root = project_root.resolve()
        self.frontend_root = self.project_root / "frontend" / "src"
        super().__init__(*args, directory=str(self.frontend_root), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        clean_path = unquote(path.split("?", 1)[0].split("#", 1)[0])

        if clean_path in ("", "/"):
            return str(self.frontend_root / "index.html")

        if clean_path.startswith("/contracts/"):
            relative_path = clean_path.lstrip("/")
            return str(self.project_root / relative_path)

        if clean_path.startswith("/config/"):
            relative_path = clean_path.lstrip("/")
            return str(self.project_root / relative_path)

        return super().translate_path(clean_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve WIFITEST frontend in web mode.")
    parser.add_argument("--root", required=True, help="Project root directory.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5174)
    args = parser.parse_args()

    project_root = Path(args.root)
    handler = partial(WifitestFrontendHandler, project_root=project_root)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"WIFITEST web frontend: http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
