"""Shared launch settings; does not change browser or operating-system policy."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "test-results"
ORIGIN = os.environ.get("LRDP_TEST_ORIGIN", "http://127.0.0.1:8787").rstrip("/")


def launch_options(*, headed: bool = False) -> dict[str, Any]:
    options: dict[str, Any] = {"headless": not headed}
    if executable := os.environ.get("CHROMIUM"):
        options["executable_path"] = executable
    args = json.loads(os.environ.get("LRDP_BROWSER_ARGS", "[]"))
    if not isinstance(args, list) or not all(isinstance(value, str) for value in args):
        raise ValueError("LRDP_BROWSER_ARGS must be a JSON array of strings")
    if args:
        options["args"] = args
    OUTPUT.mkdir(exist_ok=True)
    return options


def write_report(name: str, data: Any) -> None:
    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
