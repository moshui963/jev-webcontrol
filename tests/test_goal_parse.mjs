// tests/test_goal_parse.mjs — v0.4.26 目标拆解回归
// 核心场景：用户句子「在当前页面搜搜投影灯，找到第一个产品，点击它进入商品详情，抓取它的评论」
// v0.4.25 及之前：6 个子目标全是 click，从未出现输入框 fill 步骤 → 整条链失效。
// 修复后：必须出现 fill(搜索框) + click(搜索)，抓取类完成判定必须是 textPresent。
import { parseGoal, extractNouns, inferSuccess, searchEntries } from "../extension/lib/goal.js";
import { defaultSpecFor } from "../extension/lib/verify.js";
import { targetPresent } from "../extension/lib/calibrate.js";
import { goalSuccessFired } from "../extension/lib/governance.js";
import { judgeVerdict } from "../extension/lib/llm.js";

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name); } };

const TASK = "在当前页面搜搜投影灯，找到第一个产品，点击它进入商品详情，抓取它的评论";

// ---------- 确定性路径（无 LLM key） ----------
{
  const g = await parseGoal(TASK, undefined);
  console.log("确定性拆解:", g.subGoals.map((s) => `${s.verb}:${s.noun}${s.value ? "(" + s.value + ")" : ""}`).join(" → "));

  ok("第一步是 fill(搜索框)，值为「投影灯」", g.subGoals[0]?.verb === "fill" && g.subGoals[0]?.noun === "搜索框" && g.subGoals[0]?.value === "投影灯");
  ok("第二步是 click(搜索)", g.subGoals[1]?.verb === "click" && g.subGoals[1]?.noun === "搜索");
  ok("不再有「搜搜投影灯」这种大块 click 子目标", !g.subGoals.some((s) => s.noun.includes("搜搜")));
  ok(" glue 词「当前/它」不成为子目标", !g.subGoals.some((s) => s.noun === "当前" || s.noun === "它"));
  ok("动词短语「抓取它」被剥离，不成为子目标", !g.subGoals.some((s) => s.noun.includes("抓取")));
  ok("抓取类完成判定 = textPresent", g.successCriteria?.signal === "textPresent");
  ok("steps 与 subGoals 一一对应", g.steps.length === g.subGoals.length);
  ok("fill 步骤 verb/value 正确下传", g.steps[0]?.verb === "fill" && g.steps[0]?.value === "投影灯");
  ok("fill 步骤带 动作类型 标注原料（goalFor 用）", typeof g.steps[0]?.intent === "string" && g.steps[0].intent.includes("填写"));
}

// ---------- searchEntries 变体 ----------
{
  ok("searchEntries: 搜索星空灯", (() => { const e = searchEntries("帮我搜索星空灯"); return e.length === 2 && e[0].value === "星空灯"; })());
  ok("searchEntries: 查询合同订单", (() => { const e = searchEntries("查询合同订单"); return e[0]?.value === "合同订单"; })());
  ok("searchEntries: 无搜索意图返回空", searchEntries("打开销售管理页面").length === 0);
  ok("searchEntries: 搜一下X", (() => { const e = searchEntries("搜一下投影灯"); return e[0]?.value === "投影灯"; })());
}

// ---------- LLM 路径的 normalizeGoal（模拟 LLM 返回带动词的子目标） ----------
{
  const g = await parseGoal.__test_normalize
    ? null : null; // placeholder（normalizeGoal 未导出，走 parseGoal 确定性路径覆盖）
}
{
  // 直接构造 LLM 形状数据验证 normalizeGoal 行为：通过 parseGoal 无法注入，
  // 这里用 extractNouns/inferSuccess 组合验证胶水逻辑即可。
  const nouns = extractNouns("找到第一个产品进入商品详情看评论");
  ok("extractNouns 不产出 glue 词", !nouns.includes("进入") && !nouns.includes("看"));
  ok("inferSuccess(查看X) = elementClicked", inferSuccess("打开商品详情").signal === "elementClicked");
  ok("inferSuccess(抓取评论) = textPresent/评论", (() => { const s = inferSuccess("抓取它的评论"); return s.signal === "textPresent" && s.value === "评论"; })());
  ok("inferSuccess(导出) 不被抓取规则误吞", inferSuccess("导出全部数据").signal === "dialogClosed");
  ok("inferSuccess(下载) 优先级最高", inferSuccess("下载对账单").signal === "download");
}

// ---------- 同动词子串去重 + 跨动词共存 ----------
{
  const g = await parseGoal("搜索投影灯", undefined);
  // entries: fill(搜索框,投影灯) + click(搜索)；extractNouns 的 ACTION_ANCHORS
  // 也会追加 click(搜索) —— 精确去重后 click(搜索) 只保留一个。
  const clickSearch = g.subGoals.filter((s) => s.verb === "click" && s.noun === "搜索").length;
  ok("click(搜索) 精确去重后只保留一个", clickSearch === 1);
  ok("fill(搜索框) 与 click(搜索) 跨动词共存（子串去重不误吞）", g.subGoals.some((s) => s.verb === "fill" && s.noun === "搜索框"));
}

// ---------- v0.4.27：fill/search 校验文本必须用 value（关键词），不是 target（锚点名词） ----------
// 事故：goal 模式 fill 步骤 target=「搜索框」value=「投影灯」，verify 拿 target 去找
// 「值里包含『搜索框』的输入框」→ 永远 FAIL（fill 实际成功却被判失败）。
{
  const fillStep = { intent: "在「搜索框」填写 投影灯", verb: "fill", target: "搜索框", value: "投影灯" };
  const fSpec = defaultSpecFor(fillStep, "https://www.taobao.com", null);
  const fCheck = (fSpec.verification || []).find((c) => c.type === "input_value");
  ok("fill 校验文本 = value「投影灯」", fCheck && fCheck.text === "投影灯");

  const searchStep = { intent: "搜索 投影灯", verb: "search", target: "搜索框", value: "投影灯" };
  const sSpec = defaultSpecFor(searchStep, "https://www.taobao.com", null);
  const sChecks = sSpec.verification || [];
  ok("search 校验 = input_value(投影灯) + url_contains(投影灯)",
    sChecks.some((c) => c.type === "input_value" && c.text === "投影灯") &&
    sChecks.some((c) => c.type === "url_contains" && c.text === "投影灯"));

  // 旧 planFromNL 形态（target 即关键词）不回归
  const legacyFill = { intent: "搜搜投影灯", verb: "fill", target: "投影灯", value: "投影灯" };
  const lSpec = defaultSpecFor(legacyFill, "", null);
  ok("planFromNL 形态（target=关键词）校验不回归", (lSpec.verification || []).some((c) => c.type === "input_value" && c.text === "投影灯"));
}

// ---------- v0.4.27：needsRoute 对 fill/search 具体步骤短路（不再白等 30s Route 往返） ----------
{
  const { needsRoute } = await import("../extension/lib/llm.js");
  const fillStep = { intent: "在「搜索框」填写 投影灯", verb: "fill", target: "搜索框", value: "投影灯" };
  ok("fill 步骤不触发 Route（即使 intent 含「搜索框」且低置信）",
    needsRoute({ step: fillStep, top: 0.55, llmAvailable: true, probeMode: "none", lowConfBar: 0.6 }) === false);
  const dirStep = { intent: "点击 销售管理", verb: "click", target: "销售管理" };
  ok("方向型 click 低置信仍触发 Route", needsRoute({ step: dirStep, top: 0.4, llmAvailable: true, probeMode: "none", lowConfBar: 0.6 }) === true);
  ok("无 LLM key 不触发 Route", needsRoute({ step: dirStep, top: 0.4, llmAvailable: false, probeMode: "none", lowConfBar: 0.6 }) === false);
}

// ---------- v0.4.29: 识别只在判断层，查询层不再打同义词补丁 ----------
// 场景：天猫详情页通篇是「用户评价/多人评价」，没有「评论」二字。jev 在判断层
// 把「评论」语义对上「用户评价」并点中 —— 那个真实页面术语刻进
// step.resolvedLabel / criteria.resolvedValue，往下传。校验层只验证判断层解析
// 到的术语，不再持有一份同义词表。
{
  console.log("\n[判断层识别 · 查询层零同义词]");
  const snap = { url: "https://detail.tmall.com/x.htm", title: "商品详情", text: "用户评价 400+ 多人评价 宝贝详情", actions: [
    { kind: "click", label: "用户评价" },
    { kind: "click", label: "加入购物车" },
  ]};
  // 1) 查询层不再有同义词兜底：字面「评论」在评价页不应触发完成（必须靠判断层解析出的真实术语）。
  ok("字面「评论」在评价页不触发完成（无同义词兜底）",
    goalSuccessFired({ signal: "textPresent", value: "评论" }, { lastState: snap }) === false);
  // 2) 判断层解析出 用户评价 -> 写入 resolvedValue -> 完成判定触发。
  ok("判断层 resolvedValue=用户评价 -> 完成判定触发",
    goalSuccessFired({ signal: "textPresent", value: "评论", resolvedValue: "用户评价" }, { lastState: snap }) === true);
  // 3) 校验规格：有 resolvedLabel 时，click_effect 校验的是判断层解析到的真实术语。
  const spec = defaultSpecFor(
    { intent: "点击 评论", verb: "click", target: "评论", resolvedLabel: "用户评价" },
    "https://detail.tmall.com/x.htm", null);
  ok("click 步骤 click_effect 校验判断层解析出的真实术语「用户评价」",
    spec.verification[0]?.type === "click_effect" && spec.verification[0]?.text === "用户评价");
  // 4) 无 resolvedLabel 时回退到字面 target（兼容旧 planFromNL / 未解析场景）。
  const spec2 = defaultSpecFor(
    { intent: "点击 评论", verb: "click", target: "评论" },
    "https://detail.tmall.com/x.htm", null);
  ok("无 resolvedLabel 时校验回退到字面 target「评论」",
    spec2.verification[0]?.text === "评论");
  // 5) 页面没有「用户评价」时，即便带了 resolvedValue 也不应误判（术语须真实存在）。
  const snapEmpty = { url: "https://x.com", title: "t", text: "首页", actions: [{ kind: "click", label: "首页" }] };
  ok("resolvedValue 不在页面 -> 完成判定不触发",
    goalSuccessFired({ signal: "textPresent", value: "评论", resolvedValue: "用户评价" }, { lastState: snapEmpty }) === false);
  // 6) 暴露性检查：calibrate 不应再导出同义词 API（判断层已收口）。
  const cal = await import("../extension/lib/calibrate.js");
  ok("calibrate 不再导出 nounVariants", !("nounVariants" in cal));
  ok("calibrate 不再导出 nounPresent", !("nounPresent" in cal));
  ok("calibrate 不再导出 textMatchVariants", !("textMatchVariants" in cal));
}

// ---------- v0.4.28: 截断 JSON 抢救（完成裁判应答无法解析） ----------
{
  console.log("\n[截断 JSON 抢救]");
  ok("完整 JSON 正常解析", judgeVerdict('{"done":true,"reason":"ok","missing":[]}').done === true);
  const trunc1 = judgeVerdict('{"done":false,"reason":"评论尚未抓取'); // 截断在字符串中段
  ok("截断于字符串中段 → 抢救出 done:false", trunc1.done === false && trunc1.reason === "评论尚未抓取");
  const trunc2 = judgeVerdict('{"done":true,"reason":"页面已出现评论","missing":[]'); // 截断于数组后
  ok("截断于数组收尾 → 抢救出 done:true", trunc2.done === true);
  const trunc3 = judgeVerdict('{"done":false,"n":20,"value":"投'); // 真实日志中的截断形态
  ok("未知 schema 截断 → 不再「应答无法解析」", trunc3 && typeof trunc3.done === "boolean");
  ok("纯垃圾仍返回未完成+解析失败原因", judgeVerdict("抱歉，我无法输出 JSON").done === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
