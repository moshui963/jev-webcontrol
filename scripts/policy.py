#!/usr/bin/env python3
"""M7 (safety half) — policy gate for the HITL loop.

Borrowed from jev-browser-use's policy layer (denyNames / requireCodexNames /
allowOrigins / minConfidence) and adapted for our flow. The policy decides, for a
single proposed decision, whether it may run automatically, must be confirmed by a
human, or is outright forbidden.

It is intentionally pure (no browser, no network) so it can be unit-tested and so
the agent can evaluate it before asking the user anything.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse


@dataclass
class Policy:
    # Action labels (accessible names) that must NEVER be auto-executed.
    deny_names: list[str] = field(default_factory=list)
    # Action labels that require explicit human confirmation even if confident.
    require_human_names: list[str] = field(default_factory=list)
    # If non-empty, only these origins are permitted (substring / exact host match).
    allow_origins: list[str] = field(default_factory=list)
    # Decisions below this confidence always require human confirmation.
    min_confidence: float = 0.0
    # Sensitive verbs that auto-route to require_human (in addition to explicit lists).
    sensitive_keywords: list[str] = field(
        default_factory=lambda: ["支付", "付款", "购买", "删除", "注销", "提交订单", "发送", "publish", "delete", "submit", "pay", "send", "purchase"]
    )

    @classmethod
    def default(cls) -> "Policy":
        """A safe default: anything sensitive or low-confidence goes to a human."""
        return cls(
            deny_names=["注销账户", "删除全部", "delete everything"],
            require_human_names=[],
            allow_origins=[],
            min_confidence=0.5,
        )

    def evaluate(self, decision: dict[str, Any], url: str = "") -> dict[str, Any]:
        """Return {allowed, needs_human, reasons[]}.

        - allowed=False  -> forbidden; must not run (and must not auto-ask either).
        - needs_human=True -> may run only after explicit human confirmation.
        - allowed=True and needs_human=False -> safe to auto-execute.
        """
        label = (decision.get("label") or "").strip()
        operation = decision.get("operation") or ""
        confidence = float(decision.get("confidence") or 0.0)
        reasons: list[str] = []

        # 1) origin allow-list
        if self.allow_origins:
            host = urlparse(url).netloc
            if not any(host == o or host.endswith(o) for o in self.allow_origins):
                return {
                    "allowed": False,
                    "needs_human": False,
                    "reasons": [f"origin {host!r} not in allow_origins"],
                }

        # 2) hard deny
        for d in self.deny_names:
            if d and d in label:
                return {"allowed": False, "needs_human": False, "reasons": [f"denied by policy: name matches {d!r}"]}

        # 3) explicit require-human list
        for r in self.require_human_names:
            if r and r in label:
                reasons.append(f"name matches require_human {r!r}")
                return {"allowed": True, "needs_human": True, "reasons": reasons}

        # 4) sensitive keywords (covers submit/pay/delete/send in any language)
        for kw in self.sensitive_keywords:
            if kw and kw.lower() in label.lower():
                reasons.append(f"sensitive keyword {kw!r} -> human confirmation")
                return {"allowed": True, "needs_human": True, "reasons": reasons}

        # 5) low confidence
        if self.min_confidence and confidence < self.min_confidence:
            reasons.append(f"confidence {confidence:.2f} < min {self.min_confidence:.2f}")
            return {"allowed": True, "needs_human": True, "reasons": reasons}

        return {"allowed": True, "needs_human": False, "reasons": reasons or ["policy clear"]}


def main() -> int:
    p = Policy.default()
    cases = [
        {"label": "确认支付 ¥199", "operation": "CLICK", "confidence": 0.95, "url": "https://shop.example.com/checkout"},
        {"label": "搜索航班", "operation": "CLICK", "confidence": 0.92, "url": "https://flights.example.com"},
        {"label": "注销账户", "operation": "CLICK", "confidence": 0.99, "url": "https://app.example.com"},
        {"label": "下一页", "operation": "CLICK", "confidence": 0.31, "url": "https://app.example.com"},
    ]
    for c in cases:
        r = p.evaluate(c, c.pop("url"))
        print(f"  {c['label']:<14} conf={c['confidence']} -> allowed={r['allowed']} needs_human={r['needs_human']}  ({'; '.join(r['reasons'])})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
