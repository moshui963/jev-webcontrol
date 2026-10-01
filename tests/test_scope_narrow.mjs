// tests/test_scope_narrow.mjs — GROW 互斥范围选项按目标语义收敛的回归测试。
// 场景：导出菜单同时出现「导出全部数据 / 导出已选数据」，旧逻辑把两个都追加成
// 子步骤（点完已选才点全部，中途可能弹错误 toast 把菜单关掉）。目标文本里
// 「所有/全部」是语义证据，replan 应据此只保留匹配的范围选项。
// Run: node tests/test_scope_narrow.mjs
import { replan, filterByGoalScope } from "../extension/lib/replan.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

// ---- filterByGoalScope ----
{
  const both = [{ label: "导出全部数据" }, { label: "导出已选数据" }];
  ok("目标「所有」→ 只留 全部", filterByGoalScope(both, "导出所有合同记录").map((x) => x.label).join(",") === "导出全部数据");
  ok("目标「已选」→ 只留 已选", filterByGoalScope(both, "导出已选的合同").map((x) => x.label).join(",") === "导出已选数据");
  ok("目标无范围词 → 两个都留（不臆测）", filterByGoalScope(both, "导出合同记录").length === 2);
  ok("目标为空 → 两个都留", filterByGoalScope(both, "").length === 2);
  ok("目标说所有但页面只有已选 → 不收敛为空", filterByGoalScope([{ label: "导出已选数据" }], "导出所有合同记录").length === 1);
  ok("当前页语义词生效", filterByGoalScope([{ label: "导出全部数据" }, { label: "导出当前页" }], "只导出当前页的记录").map((x) => x.label).join(",") === "导出当前页");
}

// ---- replan GROW integration: goal text narrows appended children ----
{
  const steps = [
    { intent: "点击 导出", target: "导出", subGoal: "导出", kind: "goal-entry", expandable: true, expanded: false, status: "done" },
  ];
  const snap = { actions: [
    { label: "导出全部数据", kind: "button" },
    { label: "导出已选数据", kind: "button" },
  ] };
  const base = { steps, idx: 0, snap, subGoalNoun: "导出", controllerHistory: [], history: [], downloadFired: false };

  const narrowed = replan({ ...base, goalText: "导出所有合同记录" });
  ok("GROW: 目标含所有 → 只追加 导出全部数据", narrowed.append.length === 1 && narrowed.append[0].target === "导出全部数据");

  const all = replan({ ...base, goalText: "" });
  ok("GROW: 无目标文本 → 两个都追加（旧行为兼容）", all.append.length === 2);
}

console.log(`\n${fail ? "✗" : "✓"} test_scope_narrow: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
