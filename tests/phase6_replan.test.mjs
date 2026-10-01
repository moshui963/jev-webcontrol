// tests/phase6_replan.test.mjs — Phase 6 deterministic reflector unit tests.
// Pure logic only (no CDP / chrome). Run: node tests/phase6_replan.test.mjs
import { replan, isExpandableVerb, relatedActions } from "../extension/lib/replan.js";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + "\n      got " + g + "\n      want " + w); }
}
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

// ---- isExpandableVerb ----
ok("导出 is expandable", isExpandableVerb("导出"));
ok("提交 is expandable", isExpandableVerb("提交"));
ok("合同订单 not expandable", !isExpandableVerb("合同订单"));
ok("销售管理 not expandable", !isExpandableVerb("销售管理"));

// ---- relatedActions ----
{
  const snap = { actions: [
    { label: "导出全部数据", kind: "button" },
    { label: "导出选中数据", kind: "button" },
    { label: "导出", kind: "button" },
    { label: "刷新", kind: "button" },
    { label: "", kind: "button" },
    { label: "下一页", kind: "scroll" },
    { label: "加载中…", disabled: true, kind: "button" },
  ] };
  const rel = relatedActions(snap, "导出");
  eq("relatedActions picks 导出* labels", rel.map((r) => r.label).sort(),
     ["导出", "导出全部数据", "导出选中数据"].sort());
}

// ---- GROW: action-type entry executed -> append related child steps ----
{
  const steps = [
    { intent: "点击 导出", target: "导出", subGoal: "导出", kind: "goal-entry", expandable: true, expanded: false, status: "done" },
  ];
  const snap = { actions: [
    { label: "导出全部数据", kind: "button" },
    { label: "导出选中数据", kind: "button" },
  ] };
  const ed = replan({ steps, idx: 0, snap, subGoalNoun: "导出", successCriteria: null });
  eq("grow appends 2 child steps", ed.append.map((a) => a.target).sort(), ["导出全部数据", "导出选中数据"].sort());
  ok("grow marks them refined", ed.append.every((a) => a.kind === "refined" && a.expandOf === 0));
  eq("grow note set", ed.note.includes("细化"), true);
}

// ---- DEDUP: same label twice in snapshot -> appended once ----
{
  const steps = [
    { intent: "点击 导出", target: "导出", subGoal: "导出", kind: "goal-entry", expandable: true, expanded: false, status: "done" },
  ];
  const snap = { actions: [
    { label: "导出全部数据", kind: "button" },
    { label: "导出全部数据", kind: "button" },
  ] };
  const ed = replan({ steps, idx: 0, snap, subGoalNoun: "导出", successCriteria: null });
  eq("dedup -> 1 append", ed.append.length, 1);
}

// ---- GROW ignores already-present targets (global dedup) ----
{
  const steps = [
    { intent: "点击 导出", target: "导出", subGoal: "导出", kind: "goal-entry", expandable: true, expanded: false, status: "done" },
    { intent: "点击 导出全部数据", target: "导出全部数据", subGoal: "导出", kind: "refined", expandOf: 0, status: "done" },
  ];
  const snap = { actions: [ { label: "导出全部数据", kind: "button" } ] };
  const ed = replan({ steps, idx: 0, snap, subGoalNoun: "导出", successCriteria: null });
  eq("no duplicate of existing step", ed.append.length, 0);
}

// ---- SHRINK regression: multi-level export must NOT prune distinct siblings ----
// Repro of the premature-stop bug: after clicking 导出已选数据 the inner dialog
// still shows a single "导出" confirm button, so targetPresent(subGoal) is true,
// but 导出当前页 / 导出数据xlsx are still-needed DISTINCT steps, not redundancy.
{
  const steps = [
    { intent: "点击 导出", target: "导出", subGoal: "导出", kind: "goal-entry", expandable: true, expanded: true, status: "done" },
    { intent: "点击 导出已选数据", target: "导出已选数据", subGoal: "导出", kind: "refined", expandOf: 0, status: "done" },
    { intent: "点击 导出当前页", target: "导出当前页", subGoal: "导出", kind: "refined", expandOf: 0, status: "pending" },
    { intent: "点击 导出数据xlsx", target: "导出数据xlsx", subGoal: "导出", kind: "refined", expandOf: 0, status: "pending" },
  ];
  // single "导出" button re-appears at this level => target view "reached" per old rule
  const snap = { actions: [ { label: "导出", kind: "click" } ] };
  const ed = replan({ steps, idx: 1, snap, subGoalNoun: "导出", successCriteria: null });
  eq("shrink must NOT prune distinct siblings", ed.drop, []);
  eq("shrink note empty", ed.note, "");
}

// ---- SHRINK (legit): exact duplicate of just-executed step IS pruned ----
{
  const steps = [
    { intent: "点击 导出", target: "导出", subGoal: "导出", kind: "goal-entry", expandable: true, expanded: true, status: "done" },
    { intent: "点击 导出已选数据", target: "导出已选数据", subGoal: "导出", kind: "refined", expandOf: 0, status: "done" },
    { intent: "点击 导出已选数据", target: "导出已选数据", subGoal: "导出", kind: "refined", expandOf: 0, status: "pending" }, // accidental dup
  ];
  const snap = { actions: [ { label: "导出", kind: "click" } ] };
  const ed = replan({ steps, idx: 1, snap, subGoalNoun: "导出", successCriteria: null });
  eq("shrink drops exact duplicate", ed.drop, [2]);
  eq("shrink note mentions 裁剪", ed.note.includes("裁剪"), true);
}

// ---- non-action entry is NOT expanded ----
{
  const steps = [
    { intent: "点击 合同订单", target: "合同订单", subGoal: "合同订单", kind: "goal-entry", expandable: false, status: "done" },
  ];
  const snap = { actions: [ { label: "合同订单明细", kind: "button" } ] };
  const ed = replan({ steps, idx: 0, snap, subGoalNoun: "合同订单", successCriteria: null });
  eq("non-action entry -> no append", ed.append.length, 0);
}

// ---- done: success signal (elementClicked) fires ----
{
  const steps = [ { intent: "x", target: "x", kind: "goal-entry", status: "done" } ];
  const snap = { actions: [ { label: "合同列表", kind: "click" } ] };
  const ed = replan({ steps, idx: 0, snap, subGoalNoun: "x",
    successCriteria: { signal: "elementClicked", value: "合同列表" } });
  eq("success signal -> done", ed.done, true);
}

console.log(`\nPhase 6 replan: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
