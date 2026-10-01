// lib/decide.js — decision router: jev(TypeSafe) -> deepseek(LLM) -> mock.
import { typesafeDecide, openaiDecide } from "./jev.js";
import { llmDecide } from "./llm.js";
import { calibrateRoutes } from "./calibrate.js";

// Adjust candidate order per step verb:
// - fill steps: promote fill-able candidates to the front (stable, keeps
//   scores) — a "输入X" goal still gets ranked onto clickable links otherwise.
// - click steps: DROP fill candidates entirely (executing a fill for a click
//   step would type the target description into the search box and submit it),
//   and sink the "Open <field>" aliases (the auto-added click twin of every
//   editable field) below real buttons — their field label often matches the
//   goal better than the actual button ("Open 请输入搜索文字" outranking 搜索).
export function promoteFillable(routes, goal) {
  if (/动作类型: (fill|search)/.test(goal || "")) {
    // For fill/search steps the decider must pick WHICH INPUT to type into, not
    // whether to click a link or button. Restrict the pool to real editable
    // fields so jev scores inputs against inputs (mirrors how click steps DROP
    // fill candidates entirely). If the snapshot somehow has zero editable
    // fields we keep the full pool so the probe/LLM/browser-use fallback still
    // has candidates to work with.
    const isFill = (r) => r.action?.kind === "fill";
    const fills = routes.filter(isFill);
    if (fills.length) return fills;
    return routes;
  }
  if (/动作类型: setDate/.test(goal || "")) {
    // 日期步骤：收窄到日期/时间选择器候选（原生 date 输入或自定义日历触发元素）。
    const isDate = (r) => r.action?.kind === "setDate";
    const dates = routes.filter(isDate);
    if (dates.length) return dates;
    return routes;
  }
  if (/动作类型: click/.test(goal || "")) {
    let out = routes;
    const clicks = out.filter((r) => r.action?.kind === "click");
    if (clicks.length && clicks.length < out.length) out = clicks;
    const real = out.filter((r) => !/^Open /i.test(r.action?.label || ""));
    const alias = out.filter((r) => /^Open /i.test(r.action?.label || ""));
    if (real.length && alias.length) out = [...real, ...alias];
    return out;
  }
  return routes;
}

// Provider preference: "auto" | "jev" | "deepseek" | "mock".
// Falls back down the chain when the preferred provider has no key or errors.
export async function decideTopK(state, goal, k, cfg, pref = "auto", history = []) {
  const order = [];
  const pick = (p) => {
    if (p === "jev") order.push("jev", "deepseek", "mock");
    else if (p === "deepseek") order.push("deepseek", "jev", "mock");
    else if (p === "mock") order.push("mock");
    else order.push("jev", "deepseek", "mock");
  };
  pick(pref);

  const errors = [];
  // Calibrate BEFORE promote: raw model scores are "is this plausible?"
  // priors — sibling controls (导出/导出数据/导出记录) all score ~1.0 and the
  // percentage means nothing. calibrateRoutes multiplies in lexical/structure
  // evidence so the top route earns 100% only when it is uniquely right.
  // promoteFillable then reorders per step verb without touching scores.
  const finish = (r) => ({ ...r, routes: promoteFillable(calibrateRoutes(r.routes, goal), goal), errors });
  for (const provider of order) {
    try {
      if (provider === "jev") {
        if (!cfg.typesafeKey) throw new Error("未配置 jev API Key");
        const jevFn = cfg.jevAdapter === "openai" ? openaiDecide : typesafeDecide;
        const r = await jevFn(state, goal, k, cfg, history);
        if (!r.routes.length) throw new Error(`jev 判定无候选 (${r.operation})`);
        return finish(r);
      }
      if (provider === "deepseek") {
        if (!cfg.deepseekKey) throw new Error("未配置 DeepSeek API Key");
        return finish(await llmDecide(state, goal, k, cfg));
      }
      return finish({ routes: mockDecide(state.actions, goal, k), provider: "mock", latencyMs: 0, confidence: 0.5, errors });
    } catch (e) {
      errors.push(provider + ": " + e.message);
    }
  }
  return { routes: [], provider: "none", latencyMs: 0, confidence: 0, errors };
}

export function mockDecide(actions, intent, k = 3) {
  const tokens = (intent || "").toLowerCase().split(/\s+/).filter(Boolean);
  const VERB_FILL = /(输入|填|fill|searchbox|textbox|搜)/i;
  const VERB_CLICK = /(点|click|查询|搜索|submit|button|打开|open)/i;
  const VERB_DATE = /(日期|时间|date|年月日|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2})/i;
  const scored = (actions || [])
    .filter((a) => ["click", "fill", "select", "setDate"].includes(a.kind))
    .map((a) => {
      const hay = [a.role, a.label, JSON.stringify(a.attrs || {})].join(" ").toLowerCase();
      let score = 0;
      for (const t of tokens) if (t && hay.includes(t)) score += 1;
      // A disabled control cannot actually be clicked/filled — demote it so
      // enabled alternatives win ties (its label text still matches tokens).
      if (a.disabled) score -= 0.5;
      if (VERB_FILL.test(intent || "") && (a.kind === "fill" || a.role === "textbox" || a.role === "searchbox")) score += 0.6;
      if (VERB_DATE.test(intent || "") && a.kind === "setDate") score += 0.7;
      if (VERB_CLICK.test(intent || "")) {
        if (a.kind === "click") score += 0.4;
        if (/搜索|search|查询|submit|button|go|百度一下/.test(hay)) score += 0.5;
      }
      if (/第一条|首条|first|第一/.test(intent || "") && a.label && /1|第一|first/i.test(a.label)) score += 0.8;
      return { action: a, score: Math.round(score * 100) / 100 };
    });
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, k);
}

export function intentOf(stepText) {
  return {
    raw: stepText,
    verb: /(输入|填|搜索|搜|查询|submit)/i.test(stepText) ? "act" : "navigate-or-click",
  };
}
