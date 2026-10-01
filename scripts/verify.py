#!/usr/bin/env python3
"""M4 — declarative verification layer (Python side).

Implements the spec format from design doc §4.3:
    verification:
      - { type: url_matches,     regex: "/travel/flights/search" }
      - { type: field_value,     name: "Where from?", equals: "Zürich" }
      - { type: element_present, name: "Select flight" }
      - { type: text_contains,   text: "Sunday, September 20" }

The browser-side snapshot (snapshot_extended.js :: evaluateSpec) runs these
checks against the LIVE DOM. This module is the Python half: it parses the spec,
can evaluate against an already-captured page-state (offline, no browser), and
emits the JS snippet the harness injects for live evaluation.

Jev NEVER judges its own success — `needs_verification` is a hand-off. Final
pass/fail is decided here (declarative) + the human in the HITL loop.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


def load_spec(path: str | Path) -> dict:
    """Load a verification spec, supporting YAML (if available) or JSON."""
    text = Path(path).read_text(encoding="utf-8")
    if str(path).endswith((".yaml", ".yml")):
        try:
            import yaml  # type: ignore

            return yaml.safe_load(text)
        except ImportError:
            # fall back to JSON if PyYAML is not installed
            return json.loads(text)
    return json.loads(text)


def _offline_check(c: dict, state: dict) -> dict:
    url = state.get("url", "")
    page_text = state.get("text", "") or ""
    actions = state.get("actions", []) or []

    if c["type"] == "url_matches":
        ok = bool(re.search(c["regex"], url))
        return {"type": c["type"], "ok": ok, "detail": "" if ok else f"url {url!r} !~ {c['regex']!r}"}

    if c["type"] == "text_contains":
        ok = c["text"] in page_text
        return {"type": c["type"], "ok": ok, "detail": "" if ok else f"text {c['text']!r} not found"}

    if c["type"] == "element_present":
        ok = any(a.get("label") == c["name"] and a.get("kind") not in ("scroll", "wait") for a in actions)
        return {"type": c["type"], "ok": ok, "detail": "" if ok else f"element named {c['name']!r} not present"}

    if c["type"] == "field_value":
        ok = any(
            a.get("label") == c["name"]
            and str(a.get("value", "")).strip() == str(c["equals"]).strip()
            for a in actions
        )
        return {"type": c["type"], "ok": ok, "detail": "" if ok else f"field {c['name']!r} value != {c['equals']!r}"}

    return {"type": c.get("type", "?"), "ok": False, "detail": "unknown check type"}


def evaluate(spec: dict, state: dict) -> dict:
    """Offline evaluation against a captured page-state object."""
    checks = [_offline_check(c, state) for c in spec.get("verification", [])]
    return {"passed": all(c["ok"] for c in checks), "checks": checks}


def to_browser_script(spec: dict) -> str:
    """JS snippet for the harness to inject; returns {passed, checks} live."""
    return (
        "(() => {"
        f"const spec = {json.dumps(spec, ensure_ascii=False)};"
        "return window.__jevSnapshotExt.evaluateSpec(spec);"
        "})()"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Declarative verification (M4).")
    ap.add_argument("--table", required=True, help="path to a captured page-state JSON")
    ap.add_argument("--spec", required=True, help="path to a verification spec (.yaml/.json)")
    args = ap.parse_args()

    state = json.loads(Path(args.table).read_text(encoding="utf-8"))
    spec = load_spec(args.spec)
    result = evaluate(spec, state)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
