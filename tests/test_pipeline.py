#!/usr/bin/env python3
"""Python integration tests for the pipeline layers (no browser required)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from locator import Locator, resolve_offline  # noqa: E402
from repair import repair  # noqa: E402
from decide import Decider, action_space  # noqa: E402
from policy import Policy  # noqa: E402
from verify import evaluate  # noqa: E402
from package import build_package, dump_yaml  # noqa: E402

FIX = ROOT / "tests" / "fixtures"


def _load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def test_action_space():
    state = _load("state_before.json")
    elements, targets, controls = action_space(state["actions"])
    assert elements, "action_space must return elements"
    assert "CLICK" in targets and "TYPE_TEXT" in targets
    print("  [ok] action_space builds operation/target heads")


def test_resolve_offline_strict_and_recover():
    before = _load("state_before.json")
    after = _load("state_after.json")
    # strict (scope-matched) resolve of the moved '搜索' button must fail on new page
    loc = Locator.from_action({
        "locator": {
            "scope": "", "role": "button", "name": "搜索",
            "strategies": [
                {"type": "semantic", "role": "button", "name": "搜索", "confidence": "high"},
                {"type": "css", "selector": '[id="search-btn"]', "confidence": "high"},
            ],
        }
    })
    assert resolve_offline(loc, after["actions"]) is None, "strict resolve should fail after move"
    # ignore_scope recovery must find it
    assert resolve_offline(loc, after["actions"], ignore_scope=True) is not None, "recovery should succeed"
    print("  [ok] resolve_offline: strict fails, scope-ignoring recovers the moved button")


def test_repair_fixes_and_flags():
    plan = _load("plan_v1.json")
    after = _load("state_after.json")
    res = repair(plan, after, plan["goal"])
    r = res["report"]
    fixed_steps = [f["step"] for f in r["fixed"]]
    human_steps = [h["step"] for h in r["needs_human"]]
    assert "s3" in fixed_steps, "s3 (搜索) should auto-fix"
    assert "s4" in human_steps, "s4 (旧导出 removed) should need human"
    print("  [ok] repair auto-fixed s3, flagged s4 for human")


def test_policy_gate():
    p = Policy.default()
    assert p.evaluate({"label": "确认支付", "operation": "CLICK", "confidence": 0.95}).get("needs_human")
    assert not p.evaluate({"label": "搜索", "operation": "CLICK", "confidence": 0.92}).get("needs_human")
    assert not p.evaluate({"label": "注销账户", "operation": "CLICK", "confidence": 0.99}).get("allowed")
    print("  [ok] policy: sensitive->human, benign->auto, deny->blocked")


def test_decide_mock_shape():
    state = _load("state_before.json")
    d = Decider("mock").choose(state, "点击搜索 [pick:搜索]")
    assert d.operation == "CLICK" and d.choice == "e3"
    print("  [ok] decide(mock) returns valid CLICK decision")


def test_verify_offline():
    filled = _load("state_filled.json")
    spec = {
        "verification": [
            {"type": "field_value", "name": "Where from?", "equals": "Zürich"},
            {"type": "element_present", "name": "搜索"},
        ]
    }
    assert evaluate(spec, filled)["passed"]
    print("  [ok] verify: filled page passes spec")


def test_package_build():
    plan = _load("plan_v1.json")
    spec = {"verification": [{"type": "element_present", "name": "搜索"}]}
    out = build_package(plan["name"], plan["goal"], plan["steps"], spec, ROOT / "examples" / "flow-flight-search-test")
    for f in ("SKILL.md", "scripts/replay.py", "references/plan.yaml", "report.md"):
        assert (out / f).exists(), f"missing {f}"
    # replay dry-run must run on filled state
    import subprocess
    rp = out / "scripts" / "replay.py"
    r = subprocess.run([sys.executable, str(rp), "--dry-run", "--state", str(FIX / "state_filled.json")],
                       capture_output=True, text=True)
    assert r.returncode in (0, 1), r.stderr
    assert "Final verification: PASS" in r.stdout, r.stdout
    print("  [ok] package builds a self-contained flow Skill + replay dry-run passes core steps")


def test_yaml_emitter():
    y = dump_yaml({"a": 1, "b": {"c": "x y", "d": [1, 2]}})
    assert "a: 1" in y and "c: x y" in y and "- 1" in y
    # values with YAML-special chars get quoted
    assert '"a:b"' in dump_yaml({"k": "a:b"})
    print("  [ok] dump_yaml handles nested + plain/quoted scalars")


def main() -> int:
    tests = [
        test_action_space, test_resolve_offline_strict_and_recover, test_repair_fixes_and_flags,
        test_policy_gate, test_decide_mock_shape, test_verify_offline, test_package_build, test_yaml_emitter,
    ]
    for t in tests:
        t()
    print(f"\nAll {len(tests)} Python pipeline tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
