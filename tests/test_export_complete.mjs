// tests/test_export_complete.mjs — 多级导出弹窗（导出 → 导出全部数据 → 确认下载）
// 的回归测试。修复：
//   (1) GROW 现在对 refined 子步也继续展开（点「导出全部数据」后弹出的第 2 级确认框
//       「确定」会被补成下一步并点击），不再只展开一层；
//   (2) 漂移回退不再误杀：点「导出全部数据」导致弹窗关闭/页面变化不再被当成"偏离"腰斩任务；
//       仅当页面真漂移且无下载、且 GROW 也没补出子步时才回退。
// Run: node tests/test_export_complete.mjs
import { replan, dialogAffirmActions } from "../extension/lib/replan.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

const BEFORE = { url: "app/before", title: "t", actions: [{ label: "导出", kind: "button" }] };
const AFTER = { url: "app/after", title: "t", actions: [
  { label: "确定", kind: "button" },
  { label: "取消", kind: "button" },
  { label: "导出全部数据", kind: "button" },
] };

// ---- dialogAffirmActions ----
{
  const acts = dialogAffirmActions(AFTER, "导出");
  const labels = acts.map((a) => a.label);
  ok("affirm 命中 确定", labels.includes("确定"));
  ok("affirm 排除 取消（非确认动词）", !labels.includes("取消"));
  ok("affirm 也保留与子目标同名词（导出全部数据）", labels.includes("导出全部数据"));
  ok("空快照返回空", dialogAffirmActions(null, "导出").length === 0);
}

// 构造步骤：导出(goal-entry, done) → 导出全部数据(refined, done)
function mkSteps() {
  return [
    { intent: "点击 导出", target: "导出", subGoal: "导出", kind: "goal-entry", expandable: true, expanded: true, status: "done" },
    { intent: "点击 导出全部数据", target: "导出全部数据", subGoal: "导出", kind: "refined", expandOf: 0, expandable: false, status: "done" },
  ];
}

// ---- 修复(1)：refined 步点完「导出全部数据」弹出确认框 → 补出「确定」 ----
{
  const steps = mkSteps();
  const r = replan({
    steps, idx: 1, snap: AFTER, subGoalNoun: "导出",
    successCriteria: { signal: "download" }, controllerHistory: [], history: [],
    downloadFired: false, lastPageSig: "different", prevSnap: BEFORE,
    goalText: "导出所有合同记录",
  });
  ok("refined 步展开出 确定 子步", r.append.length === 1 && r.append[0].target === "确定");
  ok("展开后不再误触发回退（jumpTo 为空）", r.jumpTo == null);
  ok("导出全部数据 已被去重，不重复追加", !r.append.some((a) => a.target === "导出全部数据"));
}

// ---- 修复(2a)：下载已触发 → 绝不回退（即使页面变了） ----
{
  const steps = mkSteps();
  const r = replan({
    steps, idx: 1, snap: AFTER, subGoalNoun: "导出",
    successCriteria: { signal: "download" }, controllerHistory: [], history: [],
    downloadFired: true, lastPageSig: "different", prevSnap: BEFORE,
    goalText: "导出所有合同记录",
  });
  ok("下载已触发 → 不回退", r.jumpTo == null && r.append.length === 0);
}

// ---- 修复(2b)：GROW 已补出子步 → 不回退（即使页面变了） ----
{
  // snap 没有确认框也没有相关动作，GROW 无产出；但本场景故意让 GROW 产出为空、
  // 仍验证「页面变化 + 无下载 + 无新动作」才会回退。见下一条。
  const steps = mkSteps();
  const r = replan({
    steps, idx: 1, snap: AFTER, subGoalNoun: "导出",
    successCriteria: { signal: "download" }, controllerHistory: [], history: [],
    downloadFired: false, lastPageSig: "different", prevSnap: BEFORE,
    goalText: "导出所有合同记录",
  });
  // 该 snap 含 确定 → GROW 已补出 → 不应回退
  ok("GROW 已补出子步 → 即便页面变化也不回退", r.jumpTo == null);
}

// ---- 仅当真漂移（页面变 + 无下载 + GROW 无产出）才回退到稳定检查点 ----
{
  const STUCK = { url: "app/stuck", title: "t", actions: [{ label: "无关按钮", kind: "button" }] };
  const steps = mkSteps();
  const r = replan({
    steps, idx: 1, snap: STUCK, subGoalNoun: "导出",
    successCriteria: { signal: "download" }, controllerHistory: [], history: [],
    downloadFired: false, lastPageSig: "different", prevSnap: BEFORE,
    goalText: "导出所有合同记录",
  });
  ok("真漂移 → 回退到父级稳定点(goal-entry idx=0)", r.jumpTo === 0);
}

console.log(`\n${fail ? "✗" : "✓"} test_export_complete: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
