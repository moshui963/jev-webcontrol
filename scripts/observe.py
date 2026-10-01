#!/usr/bin/env python3
"""Observe a URL and emit the scope-tagged page state as JSON.

Usage:
    python scripts/observe.py --url "https://example.com" [--no-screenshot]

Requires a Chrome daemon provided by jev-ultrafast's `browser_harness`
(``pip install browser-harness==0.1.13``). The output is the same page-state
object the decision layer consumes: a list of candidate actions, each tagged
with ``scope`` (where the element lives) and ``context`` (execution context id).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Browser, StalePage  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Observe a URL with the extended snapshot.")
    ap.add_argument("--url", required=True, help="URL to open")
    ap.add_argument("--no-screenshot", action="store_true", help="skip capturing a screenshot")
    ap.add_argument("--out", help="optional path to write the JSON state to")
    args = ap.parse_args()

    try:
        browser = Browser(args.url)
    except Exception as exc:  # daemon / Chrome not available
        print(f"ERROR: could not start browser: {exc}", file=sys.stderr)
        return 2
    try:
        page = browser.observe(screenshot=not args.no_screenshot)
    except StalePage as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        browser.close()

    # Trim the heavy screenshot blob for stdout; keep it only when writing to a file.
    display = {k: v for k, v in page.items() if k != "screenshot"}
    scopes = sorted({(a.get("scope") or "(root)") for a in page["actions"]})
    print(f"url: {page['url']}")
    print(f"actions: {len(page['actions'])}  scopes: {scopes}")
    print(json.dumps(display, ensure_ascii=False, indent=2))
    if args.out:
        Path(args.out).write_text(json.dumps(page, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nwrote full state (with screenshot) -> {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
