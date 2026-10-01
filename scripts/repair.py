#!/usr/bin/env python3
"""M5 — repair layer (Python side).

Scenario B from the design: a page changed, an existing flow Skill broke. Given the
old plan (with durable locators per step) and a *freshly captured* page-state, this
module:

  1. re-resolves every step's locator against the new state (offline, no browser);
  2. a step that still resolves is kept as-is;
  3. a step that fails is a BREAKPOINT. We try to auto-recover it by re-finding the
     same element via its robust semantic identity (role + accessible name) anywhere
     on the new page — this catches moves into shadow roots / iframes and most
     re-markup. If recovered, the locator is updated in place;
  4. steps that cannot be recovered are flagged needs_human for the HITL loop.

Because resolution is done offline against a captured snapshot, the whole repair
pass is deterministic and testable without a browser (the live harness supplies the
fresh state the same way).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from locator import Locator, Strategy, resolve_offline


def repair(old_plan: dict, new_state: dict, goal: str | None = None, decider=None) -> dict:
    new_actions = new_state.get("actions", [])
    repaired_steps: list[dict] = []
    report = {"fixed": [], "unchanged": [], "needs_human": [], "goal": goal or old_plan.get("goal")}

    for step in old_plan.get("steps", []):
        loc = Locator.from_action(step)
        found = resolve_offline(loc, new_actions)
        if found:
            repaired_steps.append(dict(step))
            report["unchanged"].append(step["id"])
            continue

        # Breakpoint: try to recover by semantic identity across the whole new page
        # (the element may have moved into a shadow root / iframe and changed scope).
        recovered = None
        if loc.role and loc.name:
            sem = Locator(
                scope="", role=loc.role, name=loc.name,
                strategies=[Strategy("semantic", "high", loc.role, loc.name)],
            )
            recovered = resolve_offline(sem, new_actions, ignore_scope=True)

        if recovered:
            new_step = dict(step)
            new_step["locator"] = recovered.get("locator")
            new_step["target_label"] = recovered.get("label", "").split(" → ")[0]
            new_step["scope_before"] = loc.scope
            repaired_steps.append(new_step)
            report["fixed"].append({
                "step": step["id"],
                "old": loc.human_str(),
                "new": Locator.from_action(new_step).human_str(),
            })
        else:
            new_step = dict(step)
            new_step["broken"] = True
            repaired_steps.append(new_step)
            report["needs_human"].append({"step": step["id"], "last_known": loc.human_str()})

    return {
        "plan": {"name": old_plan.get("name"), "goal": old_plan.get("goal"), "steps": repaired_steps},
        "report": report,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Repair a flow Skill against a changed page (M5).")
    ap.add_argument("--plan", required=True, help="path to the old plan JSON (with durable locators)")
    ap.add_argument("--state", required=True, help="path to a freshly captured page-state JSON")
    ap.add_argument("--goal", default=None, help="optional goal string")
    ap.add_argument("--out", default=None, help="optional path to write the repaired plan")
    args = ap.parse_args()

    old_plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    new_state = json.loads(Path(args.state).read_text(encoding="utf-8"))
    result = repair(old_plan, new_state, args.goal)

    r = result["report"]
    print(f"修复报告（目标：{r['goal']}）")
    print(f"  未变: {', '.join(r['unchanged']) or '无'}")
    for f in r["fixed"]:
        print(f"  自动修复: {f['step']}\n     旧: {f['old']}\n     新: {f['new']}")
    for h in r["needs_human"]:
        print(f"  需人工: {h['step']}  最后已知: {h['last_known']}")

    if args.out:
        Path(args.out).write_text(json.dumps(result["plan"], ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n修复后计划已写出: {args.out}")
    return 0 if not r["needs_human"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
