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

// Split a sentence into candidate object phrases. We cut on connectives AND
// action verbs so "在氚云找到合同订单导出所有合同" yields 氚云 / 合同订单 / 导出 /
// 合同 rather than one long blob. Decorators (punctuation/space) are folded by
// targetOf; leading verbs/conjunctions are stripped by it too.
const SPLIT = /(然后|再|接着|之后|并且|并|而且|且|先|最后|，|,|。|.|；|;|、|与|和|跟|去|到|在|从|把|将|给|为|用|通过|进入|打开|找到|查?看|点开|点击|单击|选择|选中|输入|填写|填入|导出|下载|所有|全部|一下|该|这个|那个|的|里|中|页面|系统|平台|网站|工作台|后台)/g;

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
  return out;
}

// Heuristic success signal from the wording. The agent stops when this fires,
// independent of how many sub-goals were ticked.
export function inferSuccess(text) {
  const t = String(text || "");
  if (/(导出|下载|导出全部|导出所有|导出全部数据)/.test(t))
    return { signal: "dialogClosed", value: "导出", note: "导出动作触发且导出弹窗已关闭" };
  if (/(下载|保存文件|另存为)/.test(t))
    return { signal: "download", value: "", note: "触发了文件下载" };
  if (/(提交|保存|确认|发布|发送)/.test(t))
    return { signal: "elementClicked", value: "", note: "提交/保存类动作已触发" };
  if (/(查看|打开|进入|找到|定位|访问)/.test(t))
    return { signal: "elementClicked", value: "", note: "目标元素已被点击/定位" };
  return { signal: "elementClicked", value: "", note: "目标达成" };
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
  const nouns = extractNouns(text);
  return normalizeGoal(
    {
      goal: String(text || "").trim(),
      subGoals: nouns.map((n) => ({ noun: n, kind: "click" })),
      successCriteria: inferSuccess(text),
    },
    text
  );
}

// Turn the (LLM or deterministic) sub-goal list into a hypothesis step list the
// existing engine can consume, and de-duplicate obviously redundant nouns.
function normalizeGoal(g, text) {
  const subGoals = (g.subGoals || []).map((s) => ({
    noun: String(s.noun || "").trim(),
    kind: s.kind || "click",
  }));
  const steps = subGoals
    .filter((s) => s.noun.length >= 2)
    .map((s) => ({ intent: "点击 " + s.noun, verb: "click", target: s.noun }));
  return {
    goal: g.goal || String(text || "").trim(),
    subGoals,
    successCriteria: g.successCriteria || inferSuccess(text),
    steps,
  };
}
