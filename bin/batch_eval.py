#!/usr/bin/env python3
"""
batch_eval.py — v1.3 python-worker-layer stub

Stub that validates the Python worker layer integration with the Zeus plugin.
Receives JSON args via stdin (single line), returns JSON via stdout.

Convention:
  stdin  : {"action": "version|probe|...", "args": {...}}
  stdout : {"ok": bool, "result": {...}} OR {"ok": false, "error": "..."}
  exit   : 0 on success, 1 on failure

Spawned by the Obsidian plugin via lib/python-worker.js (child_process.spawn).
Future expansion: batch passport extraction, HyDE cold-start eval, regression
testing of prompt outputs, synthetic-finetuner (v1.5).

Usage (interactive):
  echo '{"action":"version"}' | python3 bin/batch_eval.py
"""
from __future__ import annotations

import json
import platform
import sys
from typing import Any


def action_version() -> dict[str, Any]:
    """Probe apple-fm-sdk availability and report environment."""
    try:
        import apple_fm_sdk  # type: ignore[import-not-found]
        sdk_version = getattr(apple_fm_sdk, "__version__", "unknown")
        sdk_available = True
        sdk_path = getattr(apple_fm_sdk, "__file__", "")
    except ImportError:
        sdk_version = None
        sdk_available = False
        sdk_path = ""

    fm_available = False
    if sdk_available:
        try:
            from apple_fm_sdk import SystemLanguageModel  # type: ignore[import-not-found]
            fm_available = SystemLanguageModel.is_available()
        except Exception:
            fm_available = False

    return {
        "python": platform.python_version(),
        "platform": f"{platform.system()} {platform.release()}",
        "machine": platform.machine(),
        "apple_fm_sdk_available": sdk_available,
        "apple_fm_sdk_version": sdk_version,
        "apple_fm_sdk_path": sdk_path,
        "fm_on_device_available": fm_available,
    }


def action_probe() -> dict[str, Any]:
    """Cheap roundtrip — confirms spawn worked. No SDK calls."""
    return {"ping": "pong", "python_worker": "alive"}


ACTIONS = {
    "version": action_version,
    "probe": action_probe,
}


def main() -> int:
    raw = sys.stdin.read().strip()
    if not raw:
        request: dict[str, Any] = {"action": "probe"}
    else:
        try:
            request = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(json.dumps({"ok": False, "error": f"invalid json: {exc}"}))
            return 1

    action = request.get("action", "probe")
    handler = ACTIONS.get(action)
    if handler is None:
        print(json.dumps({"ok": False, "error": f"unknown action: {action}",
                          "available": list(ACTIONS.keys())}))
        return 1

    try:
        result = handler()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"handler failed: {exc}"}))
        return 1

    print(json.dumps({"ok": True, "action": action, "result": result}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
