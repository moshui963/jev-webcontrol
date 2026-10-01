// tests/test_fill_judgment.mjs — 输入框"判断"强化回归（v0.4.24）
// 核心修复：fill/search 步骤不再把输入框"提到前面"，而是把候选池收窄到
// 仅可输入元素（kind:"fill"），与 click 步骤"直接丢掉 fill 候选"对称。
// 这样 jev 是在"输入框 vs 输入框"之间判断，而不是在按钮/链接/联想词噪声里挑。
// Run: node tests/test_fill_judgment.mjs
import { promoteFillable } from "../extension/lib/decide.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

// 候选池：一个搜索输入框 + 一堆会干扰的按钮/链接/联想词
const routes = [
  { action: { kind: "fill", role: "searchbox", label: "搜索框" } },
  { action: { kind: "click", role: "link", label: "热门搜索词A" } },
  { action: { kind: "click", role: "button", label: "百度一下" } },
  { action: { kind: "fill", role: "textbox", label: "用户名" } },
  { action: { kind: "click", role: "link", label: "Open 搜索框" } }, // contenteditable 的 click 孪生
];

// ---- fill 步骤：候选池必须收窄为仅 fill ----
{
  const out = promoteFillable(routes, "在搜索框输入投影灯（动作类型: fill）");
  const kinds = out.map((r) => r.action.kind);
  ok("fill 步骤只保留 fill 候选", out.length === 2 && kinds.every((k) => k === "fill"));
  ok("fill 步骤剔除按钮/链接/孪生 Open", !out.some((r) => r.action.label === "百度一下" || r.action.label === "热门搜索词A" || r.action.label === "Open 搜索框"));
}

// ---- search 步骤：同样收窄到 fill ----
{
  const out = promoteFillable(routes, "搜索投影灯（动作类型: search）");
  ok("search 步骤也只保留 fill 候选", out.length === 2 && out.every((r) => r.action.kind === "fill"));
}

// ---- click 步骤：行为不变，仅保留 click（丢掉 fill + 孪生） ----
{
  const out = promoteFillable(routes, "点击百度一下（动作类型: click）");
  ok("click 步骤只保留 click 候选", out.every((r) => r.action.kind === "click"));
  ok("click 步骤剔除 fill 输入框", !out.some((r) => r.action.kind === "fill"));
}

// ---- 极端：快照里没有任何可输入元素 → 不收窄（保留全部，交给探针/LLM 兜底） ----
{
  const onlyClicks = [
    { action: { kind: "click", role: "button", label: "A" } },
    { action: { kind: "click", role: "link", label: "B" } },
  ];
  const out = promoteFillable(onlyClicks, "在框里输入X（动作类型: fill）");
  ok("无 fill 候选时不收窄（保留全部供兜底）", out.length === 2);
}

// ---- 非 fill/click/search 的 goal 标记：原样返回 ----
{
  const out = promoteFillable(routes, "随意目标");
  ok("无动作类型标记时原样返回", out.length === routes.length);
}

console.log(`\n${fail ? "✗" : "✓"} test_fill_judgment: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
