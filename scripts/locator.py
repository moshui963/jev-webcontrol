#!/usr/bin/env python3
"""M2 — durable locator orchestration layer (Python side).

The browser-side snapshot already synthesizes a durable locator for every
candidate action (see snapshot_extended.js :: locatorOf). This module is the
Python half: it consumes that locator, ranks its strategies, and emits the
JavaScript snippet the harness injects to *re-find* the element during replay
or repair — without ever needing a real DOM in Python.

A locator is markup-independent: it prefers stable attributes (#id, data-testid,
name, aria-label), then falls back to a structural CSS path, and finally to a
semantic identity (role + accessible name) that survives most DOM churn.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

# Best-first ordering for resolve attempts.
_CONFIDENCE_RANK = {"high": 0, "medium": 1, "low": 2}


@dataclass
class Strategy:
    type: str  # "semantic" | "css" | "css-path"
    confidence: str  # "high" | "medium" | "low"
    role: str | None = None
    name: str | None = None
    selector: str | None = None

    def describe(self) -> str:
        if self.type == "semantic":
            return f"semantic[{self.role}={self.name!r}]"
        return f"{self.type}:{self.selector}"


@dataclass
class Locator:
    scope: str
    role: str | None
    name: str | None
    strategies: list[Strategy] = field(default_factory=list)

    @classmethod
    def from_action(cls, action: dict[str, Any]) -> "Locator":
        """Build a Locator from a snapshot action's embedded locator dict."""
        loc = action.get("locator") or {}
        strategies = [
            Strategy(
                type=s.get("type"),
                confidence=s.get("confidence", "low"),
                role=s.get("role"),
                name=s.get("name"),
                selector=s.get("selector"),
            )
            for s in loc.get("strategies", [])
        ]
        return cls(
            scope=loc.get("scope", ""),
            role=loc.get("role"),
            name=loc.get("name"),
            strategies=strategies,
        )

    def ordered_strategies(self) -> list[Strategy]:
        return sorted(self.strategies, key=lambda s: _CONFIDENCE_RANK.get(s.confidence, 9))

    def primary(self) -> Strategy | None:
        ordered = self.ordered_strategies()
        return ordered[0] if ordered else None

    def human_str(self) -> str:
        where = self.scope or "(main document)"
        primary = self.primary()
        prim = primary.describe() if primary else "?"
        return f"[{where}] {self.role or '?'} {self.name or ''!r}  ->  {prim}"

    def to_json(self) -> str:
        """Compact JSON for embedding inside the injected JS."""
        return json.dumps(
            {
                "scope": self.scope,
                "role": self.role,
                "name": self.name,
                "strategies": [
                    {
                        "type": s.type,
                        "confidence": s.confidence,
                        "role": s.role,
                        "name": s.name,
                        "selector": s.selector,
                    }
                    for s in self.strategies
                ],
            },
            ensure_ascii=False,
        )

    def to_browser_script(self) -> str:
        """JS snippet for the harness to inject; returns element center or null.

        The harness evaluates this in the page context, where
        ``window.__jevSnapshotExt.resolve`` is available. Returns
        ``{x, y, found:true}`` or ``null``.
        """
        return (
            "(() => {"
            f"const loc = {self.to_json()};"
            "const node = window.__jevSnapshotExt.resolve(document, loc);"
            "if (!node) return null;"
            "const r = node.getBoundingClientRect();"
            "return { x: r.x + r.width/2, y: r.y + r.height/2, found: true };"
            "})()"
        )


def _base_label(label: str | None) -> str:
    return (label or "").split(" → ")[0].strip()


def _parse_css_selector(selector: str | None) -> tuple[str, str] | None:
    """Parse a simple `[attr="val"]` selector used by our css strategies."""
    if not selector:
        return None
    m = re.match(r"""\[([\w-]+)\s*=\s*['"]([^'"]+)['"]\]""", selector)
    return (m.group(1), m.group(2)) if m else None


def resolve_offline(loc: "Locator", actions: list[dict], ignore_scope: bool = False) -> dict | None:
    """Re-find an element from a locator against a *captured* page-state.

    Mirrors snapshot_extended.js :: resolve but operates on the JSON snapshot
    (which carries role/label/scope/attrs per action) instead of a live DOM.
    Returns the matched action dict (with its own durable locator) or None.

    This is what lets the repair layer detect breakpoints without a browser.
    Pass ignore_scope=True when recovering a breakpoint by semantic identity
    (the element may have moved into a shadow root / iframe and changed scope).
    """
    candidates = actions if ignore_scope else [a for a in actions if (a.get("scope") or "") == (loc.scope or "")]
    for s in loc.ordered_strategies():
        for a in candidates:
            if s.type == "semantic":
                if a.get("role") == loc.role and _base_label(a.get("label")) == (loc.name or "").strip():
                    return a
            elif s.type == "css":
                parsed = _parse_css_selector(s.selector)
                if parsed:
                    attr, val = parsed
                    if (a.get("attrs") or {}).get(attr) == val:
                        return a
            # css-path cannot be matched offline (no structural info); skip
    return None


def main() -> int:
    # Tiny self-check (no browser): round-trips a hand-built locator.
    sample = {
        "locator": {
            "scope": "div#shadow-host::shadow/",
            "role": "button",
            "name": "保存(Lightning 组件)",
            "strategies": [
                {"type": "semantic", "role": "button", "name": "保存(Lightning 组件)", "confidence": "high"},
                {"type": "css", "selector": '[id="lightning-save"]', "confidence": "high"},
                {"type": "css-path", "selector": "button", "confidence": "low"},
            ],
        }
    }
    loc = Locator.from_action(sample)
    print("locator:", loc.human_str())
    print("primary:", loc.primary().describe())
    print("browser script:\n" + loc.to_browser_script())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
