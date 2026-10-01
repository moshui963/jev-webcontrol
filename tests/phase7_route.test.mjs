// Phase 7 — Route layer (Plan-and-Execute: LLM 判路线, jev 执行) 纯逻辑单测。
// 覆盖 needsRoute 谓词 / parseRouteResponse 解析 / planExhaustedAction 终止决策。
// 不联网、不依赖 chrome 环境，纯函数可独立验证。
import { needsRoute, parseRouteResponse, planExhaustedAction, parseSkipResponse } from "../extension/lib/llm.js";
import { revealSkipCandidate } from "../extension/lib/calibrate.js";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + "\n      got : " + g + "\n      want: " + w); }
}
function truthy(name, v) { if (v) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + " (expected truthy, got " + JSON.stringify(v) + ")"); } }
function falsy(name, v) { if (!v) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + " (expected falsy, got " + JSON.stringify(v) + ")"); } }

console.log("needsRoute 谓词:");
{
  // 动作型多级子目标 + 有 LLM key -> 触发（进入即规划一次，LLM 有真实价值）
  truthy("expandable 动作型子目标触发", needsRoute({ step: { expandable: true, intent: "点击 导出" }, top: 0.9, llmAvailable: true, probeMode: "click" }));
  // 导航型措辞 + jev 高置信 -> 不触发（v0.4.14 性能修正：旧版无条件触发，
  // 导致 jev 已 100% 命中仍白等一次 mode=direct 的 LLM 往返 3~5s）
  falsy("导航型+高置信不触发", needsRoute({ step: { intent: "找到销售管理" }, top: 0.9, llmAvailable: true, probeMode: "click" }));
  // 导航型措辞 + jev 低置信 -> 触发
  truthy("导航型+低置信触发", needsRoute({ step: { intent: "找到销售管理" }, top: 0.5, llmAvailable: true, probeMode: "click" }));
  // 自定义阈值：0.7 时 top 0.65 算低置信
  truthy("自定义阈值生效", needsRoute({ step: { intent: "找到销售管理" }, top: 0.65, llmAvailable: true, probeMode: "click", lowConfBar: 0.7 }));
  // 普通点击 + 探针有果 + 低置信（无导航措辞）-> 不触发（走 judgeStep/browser-use 旧链）
  falsy("普通点击低置信不触发", needsRoute({ step: { intent: "点击 X" }, top: 0.1, llmAvailable: true, probeMode: "click" }));
  // 探针无果 + 低置信 -> 触发
  truthy("探针无果+低置信触发", needsRoute({ step: { intent: "点击 X" }, top: 0.1, llmAvailable: true, probeMode: "none" }));
  // 普通 refined 点击、可见、置信高 -> 不触发（交给 jev 快速点）
  falsy("普通可见点击不触发", needsRoute({ step: { kind: "refined", intent: "点击 合同订单" }, top: 0.9, llmAvailable: true, probeMode: "click" }));
  // 无 LLM key -> 任何情况都不触发（降级到旧兜底链）
  falsy("无 LLM key 不触发", needsRoute({ step: { expandable: true, intent: "点击 导出" }, top: 0.1, llmAvailable: false, probeMode: "none" }));
}

console.log("parseRouteResponse 解析:");
{
  const route = parseRouteResponse('{"mode":"route","steps":[{"intent":"展开销售管理","verb":"click","target":"销售管理","subGoal":"销售管理"},{"intent":"点击合同订单","verb":"click","target":"合同订单","subGoal":"合同订单"}]}');
  eq("route 解析", route, { mode: "route", steps: [
    { intent: "展开销售管理", verb: "click", target: "销售管理", subGoal: "销售管理", kind: "refined", expandable: false },
    { intent: "点击合同订单", verb: "click", target: "合同订单", subGoal: "合同订单", kind: "refined", expandable: false },
  ] });
  eq("direct 解析", parseRouteResponse('{"mode":"direct","target":"导出数据(xlsx)"}'), { mode: "direct", target: "导出数据(xlsx)" });
  eq("blocked 解析", parseRouteResponse('{"mode":"blocked","reason":"需要登录"}'), { mode: "blocked", reason: "需要登录" });
  // 宽松解析：markdown 代码块包裹也能解析
  eq("markdown 包裹解析", parseRouteResponse('```json\n{"mode":"direct","target":"确定"}\n```'), { mode: "direct", target: "确定" });
  // 失败形态
  falsy("乱码返回 null", parseRouteResponse("不是 JSON ???"));
  falsy("route 无 steps 返回 null", parseRouteResponse('{"mode":"route","steps":[]}'));
  falsy("缺 mode 返回 null", parseRouteResponse('{"target":"x"}'));
}

console.log("planExhaustedAction 终止决策:");
{
  eq("顺序模式 -> normal", planExhaustedAction({ goalMode: false, successFired: false, routeExtended: false, routeExtends: 0 }), "normal");
  eq("成功信号触发 -> success", planExhaustedAction({ goalMode: true, successFired: true, routeExtended: false, routeExtends: 0 }), "success");
  eq("已补全 -> continue", planExhaustedAction({ goalMode: true, successFired: false, routeExtended: true, routeExtends: 0 }), "continue");
  eq("超上限 -> escalate", planExhaustedAction({ goalMode: true, successFired: false, routeExtended: false, routeExtends: 5 }), "escalate");
  eq("可尝试补全 -> route_try", planExhaustedAction({ goalMode: true, successFired: false, routeExtended: false, routeExtends: 0 }), "route_try");
}

console.log("revealSkipCandidate 探测（不再直接跳过）:");
{
  const snap = { actions: [ { kind: "click", label: "导出全部数据", disabled: false } ] };
  const clickStep = { verb: "click", intent: "点击 导出", target: "导出" };
  const nextStep = { verb: "click", intent: "点击 导出全部数据", target: "导出全部数据" };
  // 条件满足 -> 返回候选目标（交给 LLM 判定，而非直接跳过）
  eq("条件满足返回候选", revealSkipCandidate(clickStep, nextStep, snap, 0, 1), "导出全部数据");
  // 下一步目标不在页面 -> 不触发
  const snap2 = { actions: [ { kind: "click", label: "其他", disabled: false } ] };
  falsy("下一步目标缺失不触发", revealSkipCandidate(clickStep, nextStep, snap2, 0, 1));
  // 非连续已验证 -> 不触发
  falsy("非连续验证不触发", revealSkipCandidate(clickStep, nextStep, snap, -1, 1));
  // 下一步非 click -> 不触发
  const nextFill = { verb: "fill", intent: "输入 X", target: "X" };
  falsy("下一步非 click 不触发", revealSkipCandidate(clickStep, nextFill, snap, 0, 1));
}

console.log("parseSkipResponse 解析:");
{
  eq("skip", parseSkipResponse('{"decision":"skip","reason":"弹窗已打开"}'), { skip: true, reason: "弹窗已打开" });
  eq("proceed", parseSkipResponse('{"decision":"proceed"}'), { skip: false });
  falsy("无决策->null", parseSkipResponse("不是json"));
}

console.log("\nPhase 7 结果: " + pass + " 通过, " + fail + " 失败");
if (fail > 0) process.exit(1);
