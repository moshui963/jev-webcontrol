// Goal ingestion for the agentic (goal-driven) mode.
//
// The old mode consumed a USER-WRITTEN step list ("点击 A → 点击 B → 导出…").
// Real users give ONE short sentence and expect the agent to figure out the
// steps: "在氚云页面找到合同订单导出所有合同". This module turns that sentence
// into a structured objective the engine can drive:
//   - `subGoals`: ordered target nouns to progressively reveal/act on
//     (合同订单 → 导出 → 导出全部数据 → 导出). These are ANCHORS, not clicks:
//     the unknown middle navigation is discovered at run time by the Controller.
//   - `successCriteria`: how we know the GOAL is done (download fired / the
//     final 导出 clicked / a dialog closed) — NOT "all steps were clicked".
//   - `steps`: a *hypothesis* step list derived from the nouns, so the existing
//     sequential engine can run it unchanged in Phase 2 while the Controller
//     is allowed to deviate/extend it.
//
// Two paths: an LLM parse when a key is present (goalFromNL in llm.js), and a
// deterministic extractor (extractNouns/inferSuccess) used as fallback and in
// tests. The deterministic path is intentionally simple — it only needs to
// pull *plausible* UI nouns out of a sentence; the LLM path is where real
// disambiguation happens.

import { targetOf } from "./calibrate.js";
import { goalFromNL } from "./llm.js";
import { isExpandableVerb } from "./replan.js";

// Split a sentence into candidate object phrases. We cut on connectives AND
// action verbs so "在氚云找到合同订单导出所有合同" yields 氚云 / 合同订单 / 导出 /
// 合同 rather than one long blob. Decorators (punctuation/space) are folded by
// targetOf; leading verbs/conjunctions are stripped by it too.
const SPLIT = /(?:然后|再|接着|之后|并且|并|而且|且|先|最后|，|,|。|\.|；|;|、|与|和|跟|去|到|在|从|把|将|给|为|用|通过|进入|打开|找到|查?看|点开|点击|单击|选择|选中|输入|填写|填入|导出|下载|所有|全部|一下|该|这个|那个|的|里|中|页面|系统|平台|网站|工作台|后台)/g;

// Action verbs that ARE the goal (导出/下载/提交…), not mere glue. They are
// delimiters in SPLIT (so 合同订单|导出 separate cleanly) yet must still surface
// as sub-goals — so after splitting we re-detect them from the raw text and
// append. Without this, "导出" would be eaten as a delimiter and the goal's
// pivotal action would vanish from the plan.
const ACTION_ANCHORS = ["导出", "下载", "提交", "保存", "发布", "登录", "搜索", "上传", "打印"];

export function extractNouns(text) {
  const out = [];
  const seen = new Set();
  const segs = String(text || "")
    .split(/[，,。.；;、\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const push = (raw) => {
    const n = targetOf(raw);
    if (n && n.length >= 2 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  if (!segs.length) push(text);
  for (const seg of segs) {
    for (const part of seg.split(SPLIT).map((s) => s.trim()).filter(Boolean)) {
      push(part);
    }
  }
  // Re-attach the goal action verbs as sub-goal anchors.
  for (const a of ACTION_ANCHORS) {
    if (String(text || "").includes(a) && !seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

// Heuristic success signal from the wording. The agent stops when this fires,
// independent of how many sub-goals were ticked.
export function inferSuccess(text) {
  const t = String(text || "");
  if (/(下载|保存文件|另存为)/.test(t))
    return { signal: "download", value: "", note: "触发了文件下载" };
  // 抓取/采集/评论类：目标是「页面出现内容」，不是「点中某元素」
  if (/(抓取|爬取|采集|提取|抓下来|评论)/.test(t))
    return { signal: "textPresent", value: /评论/.test(t) ? "评论" : "", note: "页面出现要抓取的内容（如评论列表）" };
  if (/(导出|导出全部|导出所有|导出全部数据)/.test(t))
    return { signal: "dialogClosed", value: "导出", note: "导出动作触发且导出弹窗已关闭" };
  if (/(提交|保存|确认|发布|发送)/.test(t))
    return { signal: "elementClicked", value: "", note: "提交/保存类动作已触发" };
  if (/(查看|打开|进入|找到|定位|访问)/.test(t))
    return { signal: "elementClicked", value: "", note: "目标元素已被点击/定位" };
  return { signal: "elementClicked", value: "", note: "目标达成" };
}

// Deterministic search detection: 「搜X/搜索X/查X」→ fill(搜索框, X) + click(搜索).
// Used by the no-LLM fallback path so even without a key the plan contains a
// real fill step instead of a click on a non-existent "搜X" link.
const SEARCH_RE = /(?:搜搜|搜索|搜一下|查询|查找|搜)\s*([^\s，,。.；;、的]{2,20})/;
export function searchEntries(text) {
  const m = String(text || "").match(SEARCH_RE);
  if (!m) return [];
  const kw = (m[1] || "").replace(/^(一下|下)/, "").trim();
  if (kw.length < 2) return [];
  return [
    { noun: "搜索框", verb: "fill", value: kw },
    { noun: "搜索", verb: "click" },
  ];
}

// Build the structured objective. LLM path first (richer disambiguation),
// deterministic fallback otherwise. `cfg` may be undefined (tests).
export async function parseGoal(text, cfg) {
  if (cfg && cfg.deepseekKey) {
    try {
      const g = await goalFromNL(text, cfg);
      if (g && Array.isArray(g.subGoals) && g.subGoals.length) {
        return normalizeGoal(g, text);
      }
    } catch {
      /* fall through to deterministic */
    }
  }
  const nouns = extractNouns(text).map((n) => ({ noun: n, verb: "click" }));
  const entries = searchEntries(text);
  if (entries.length) {
    const kw = entries[0].value;
    // Drop click blobs that merely wrap the keyword ("搜搜投影灯") — the real
    // fill+click pair above replaces them.
    const kept = nouns.filter((e) => !(kw && e.noun.includes(kw)) && e.noun !== "搜索");
    return normalizeGoal(
      {
        goal: String(text || "").trim(),
        subGoals: [...entries, ...kept],
        successCriteria: inferSuccess(text),
      },
      text
    );
  }
  return normalizeGoal(
    {
      goal: String(text || "").trim(),
      subGoals: nouns,
      successCriteria: inferSuccess(text),
    },
    text
  );
}

// Words that are sentence glue, not UI targets. The deterministic extractor can
// surface them ("页面"/"找到"/"所有"); they must never become sub-goals/steps.
const STOP_NOUNS = new Set([
  "页面", "系统", "平台", "网站", "工作台", "后台", "找到", "进入", "打开",
  "所有", "全部", "该", "这个", "那个", "里", "中", "的",
  "当前", "它", "其", "此", "本",
]);

// Plan-layer verbs a sub-goal may carry. read = "只需页面出现某内容"（抓取/
// 查看/评论）——执行上仍是点开内容入口（click），但完成判定应转为 textPresent。
const GOAL_VERBS = new Set(["click", "fill", "search", "select", "setDate", "read"]);

// Turn the (LLM or deterministic) sub-goal list into a hypothesis step list the
// existing engine can consume, dropping glue words and merging sub-string
// duplicates ("合同" + "合同订单" -> keep "合同订单").
// v0.4.26: sub-goals now carry a VERB (LLM path: goalFromNL; deterministic
// path: searchEntries). Steps are built per verb — 「搜X」becomes
// fill(搜索框, X) + click(搜索提交按钮) instead of a doomed click on a
// non-existent "搜X" link. Steps and subGoals stay 1:1 (runStep lock-steps
// subGoalIdx to the step index).
function normalizeGoal(g, text) {
  // Strip a leading action verb from a noun ("抓取它" -> "它", "查看评论" ->
  // "评论"): verb phrases are not UI targets. If nothing remains the entry is
  // dropped by the STOP_NOUNS/length filter below.
  const LEAD_VERB = /^(抓取|爬取|采集|提取|查看|点开|点击|单击|进入|打开|找到)/;
  let entries = (g.subGoals || [])
    .map((s) => {
      const noun = String((s && s.noun) || "").replace(LEAD_VERB, "").trim() || String((s && s.noun) || "").trim();
      let verb = String((s && s.verb) || "click").toLowerCase();
      if (!GOAL_VERBS.has(verb)) verb = "click";
      return { noun, verb, value: String((s && s.value) || "").trim() };
    })
    .filter((e) => e.noun.length >= 2 && !STOP_NOUNS.has(e.noun));
  // Exact de-dup (same noun+verb), then drop a noun that is a sub-string of
  // another kept noun with the SAME verb (合同 ⊂ 合同订单, both click).
  // Different verbs co-exist: 搜索框(fill) and 搜索(click) are both real.
  entries = entries.filter(
    (a, i) => !entries.some((b, j) => j < i && b.verb === a.verb && b.noun === a.noun) &&
      !entries.some((b) => b !== a && b.verb === a.verb && b.noun.includes(a.noun))
  );
  const subGoals = entries.map(({ noun, verb, value }) => ({ noun, verb, value }));
  // Phase 6: each step carries its sub-goal anchor + whether it is an action-type
  // entry that should be expanded into child steps at run time (replan.js owns
  // the verb classifier; no circular import — replan.js only imports calibrate/
  // governance, never goal.js).
  const steps = entries.map((e) => {
    if (e.verb === "fill" || e.verb === "search") {
      const kw = e.value || e.noun;
      return {
        intent: e.verb === "search" ? `搜索 ${kw}` : `在「${e.noun}」填写 ${kw}`,
        verb: e.verb,
        target: e.noun,
        value: kw,
        subGoal: e.noun,
        kind: "goal-entry",
        expandable: false,
        expanded: false,
      };
    }
    // click / read / select / setDate entries: the entry action is a click on
    // the content entry; select/setDate refinement happens at execution time.
    return {
      intent: "点击 " + e.noun,
      verb: "click",
      target: e.noun,
      subGoal: e.noun,
      kind: "goal-entry",
      expandable: isExpandableVerb(e.noun),
      expanded: false,
    };
  });
  return {
    goal: g.goal || String(text || "").trim(),
    subGoals,
    successCriteria: g.successCriteria || inferSuccess(text),
    steps,
  };
}
