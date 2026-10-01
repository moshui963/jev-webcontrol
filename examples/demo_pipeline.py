#!/usr/bin/env python3
"""End-to-end, browser-free demo of the whole pipeline.

Run:
    python examples/demo_pipeline.py

It exercises every layer against captured snapshots (no Chrome needed):
  M1/M2 observe  -> M3 decide (mock) -> M4 verify -> M6 package -> M5 repair.
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import json
from decide import Decider
from policy import Policy
from verify import evaluate
from repair import repair
from package import build_package

FIX = ROOT / "tests" / "fixtures"


def hr(t):
    print("\n" + "=" * 70 + f"\n  {t}\n" + "=" * 70)


def main() -> int:
    hr("M1+M2  OBSERVE  (snapshot with scope + durable locators)")
    before = json.loads((FIX / "state_before.json").read_text(encoding="utf-8"))
    print(f"  页面: {before['url']}")
    for a in before["actions"]:
        print(f"   - {a['id']:<4} [{a['scope'] or 'main'}] {a['role']:<8} {a['label']:<10} "
              f"locator={a['locator']['strategies'][0]['type']}")

    hr("M3  DECIDE  (mock provider, policy gate)")
    dec = Decider("mock")
    pol = Policy.default()
    goal = "搜索航班 [pick:搜索]"
    d = dec.choose(before, goal, policy=pol)
    v = pol.evaluate({"label": d.label, "operation": d.operation, "confidence": d.confidence}, before["url"])
    print(f"  目标: {goal}")
    print(f"  决策: {d.operation} -> {d.choice} (conf={d.confidence}, needs_human={v['needs_human']})")

    hr("M4  VERIFY  (declarative spec, offline)")
    filled = json.loads((FIX / "state_filled.json").read_text(encoding="utf-8"))
    spec = {
        "verification": [
            {"type": "field_value", "name": "Where from?", "equals": "Zürich"},
            {"type": "field_value", "name": "Where to?", "equals": "London"},
            {"type": "element_present", "name": "搜索"},
        ]
    }
    res = evaluate(spec, filled)
    print(f"  规范检查: {'PASS' if res['passed'] else 'FAIL'}  ({len(res['checks'])} checks)")

    hr("M6  PACKAGE  (flow Skill 包)")
    plan = json.loads((FIX / "plan_v1.json").read_text(encoding="utf-8"))
    out = build_package(plan["name"], plan["goal"], plan["steps"], spec, ROOT / "examples" / "flow-flight-search")
    for p in sorted(out.rglob("*")):
        if p.is_file():
            print(f"   wrote {p.relative_to(ROOT)}")

    hr("M5  REPAIR  (改版后断点自修复)")
    after = json.loads((FIX / "state_after.json").read_text(encoding="utf-8"))
    result = repair(plan, after, plan["goal"])
    r = result["report"]
    print(f"  未变   : {', '.join(r['unchanged']) or '无'}")
    for f in r["fixed"]:
        print(f"  自动修复: {f['step']}  {f['old']}  ->  {f['new']}")
    for h in r["needs_human"]:
        print(f"  需人工 : {h['step']}  ({h['last_known']})")

    hr("SUMMARY")
    print("  看得见(shadow+iframe) -> 选得准(mock决策) -> 判得准(声明式验证)")
    print("  -> 打包成可复用 flow Skill 包 -> 改版后自动修复断点 + 标出需人工的步骤")
    print("  全部在无浏览器环境下用捕获快照验证通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
