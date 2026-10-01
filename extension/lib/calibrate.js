// lib/calibrate.js — confidence calibration layer.
//
// Raw model scores (jev noul / LLM p) answer one question: "is this element
// plausible for the goal?". For sibling controls that all relate to the
// goal's noun (导出 / 导出数据 / 导出记录) the honest answer is "yes" for
// each — so every route lands at ~1.0 and the displayed percentage carries
// no information. Calibration fixes this ARCHITECTURALLY, in one place for
// every provider, by multiplying the model prior with independent evidence:
//
//   p = model × lexicalTier × competition × disabled
//
//   lexicalTier  — how exactly the candidate label matches the goal's noun
//                  phrase. BIDIRECTIONAL evidence: exact wording AGREES with a
//                  goal that names a concrete element (弹性云服务器) and lifts
//                  the score; readable text that contradicts the noun DEMOTES;
//                  a label that merely differs ("百度一下" vs "搜索") only
//                  mildly demotes, since wording often differs from intent.
//                  An element with NO readable text (label fell back to its
//                  role name: "link"/"button") carries no evidence at all —
//                  its model prior is capped, because the model is guessing
//                  from position/URL context, and a mystery element must never
//                  outrank one the goal's own wording confirms.
//   competition  — identical labels at the same tier split the probability:
//                  two identical 导出 buttons means neither is certain.
//   disabled     — a disabled control cannot actually act: ×0.3.
//
// The result is a probability that means something: 100% only when the model
// AND the wording agree on a unique, enabled element.

// Normalise for COMPARISON: lowercase, drop ALL whitespace AND punctuation —
// page labels are decorated ("生产ERP【2.0】", "取 消", "销售管理【最新】") while
// the goal text is plain ("生产erp2.0"). Folding punctuation is what makes
// exact/prefix/contains tiers meaningful; keeping it would misclassify the
// real target as "unrelated" and demote it.
const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
// Shared with the engine: skip/alignment decisions must compare labels in the
// SAME folded space as calibration, or decorated labels defeat them.
export const foldText = norm;

// Vocabulary reconciliation ("评论" on the goal vs "用户评价" on the page) is
// NOT done here with a synonym table. It happens ONCE at the judgment layer:
// jev/LLM pick the real on-page element ("用户评价") and that resolved label is
// stamped onto the step (step.resolvedLabel) and the goal's success criteria
// (criteria.resolvedValue). Downstream verification/completion then match
// against the RESOLVED real term — no second, divergent synonym dictionary in
// the query layer. (See background.js execCandidate + governance.js.)

// Is exactly ONE interactable, non-disabled click target with the given noun
// present on the page? Exact (folded) label match — used by Pillar A skip
// reconciliation, sub-goal progress, and goal-done detection.
export function targetPresent(snap, query) {
  if (!snap || !snap.actions) return false;
  const q = foldText(query);
  if (!q) return false;
  const hits = snap.actions.filter(
    (a) => a.kind === "click" && !a.disabled && foldText(a.label) === q
  );
  return hits.length === 1;
}

// Detector for "should we even CONSIDER skipping this reveal click?".
// Returns the next step's target noun when the OLD brittle auto-skip condition
// holds (current + next are clicks, prior steps verified contiguously, next
// target uniquely present on the page) — but makes NO decision. The actual
// skip/no-skip call is handed to the Route(LLM) layer (routeShouldSkip), so the
// fragile "label present → reveal already happened" assumption is replaced by a
// real page-state analysis. Returns null when the condition isn't met.
export function revealSkipCandidate(step, nextStep, snap, verifiedUpto, idx) {
  if (!step || step.verb !== "click" || !nextStep || nextStep.verb !== "click") return null;
  if (!Number.isInteger(verifiedUpto) || verifiedUpto < 0 || verifiedUpto < idx - 1) return null;
  const t = (nextStep.target || nextStep.intent || "").replace(/^(点击|点)\s*/, "").trim();
  if (!t) return null;
  if (targetPresent(snap, t)) return t;
  return null;
}

// Snapshot label fallback: `name(el) || rname` — an element with no accessible
// name gets its ROLE as label. Such a label is a placeholder, not evidence.
const ROLE_WORDS = new Set([
  "link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "img",
  "image", "switch", "heading", "generic", "menu", "search", "list",
  "listitem", "gridcell", "row", "cell", "treeitem", "slider", "spinbutton",
  "dialog", "navigation", "banner", "contentinfo", "main", "region",
]);

// Does this action's label carry REAL text evidence (not a role-name fallback)?
function readable(a) {
  const l = norm(a?.label);
  return !!l && l !== norm(a?.role) && !ROLE_WORDS.has(l);
}

const VERB =
  /^(点击|点一下|点|单击|双击|输入|填写|填入|填|选择|选中|选|打开|搜索|提交|勾选|取消勾选|按|按下|上传|下载|登录|进入|切换到|切换|等待|滚动)/;
const CONJ = /^(然后|再|接着|之后|并|且|先|最后|，|,|、|去|到|在)/;

// The noun phrase the step is about: strip annotations (（动作类型: click）…),
// then leading verbs/conjunctions ("点击 然后点击销售管理" -> "销售管理").
// A strip that would empty the string is refused — "点击 导出" keeps 导出
// as the target instead of eating it as a verb.
export function targetOf(goal) {
  let g = String(goal || "")
    .replace(/（[^）]*）/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .trim();
  const strip = (re) => {
    const rest = g.replace(re, "").trim();
    if (rest && rest !== g) {
      g = rest;
      return true;
    }
    return false;
  };
  for (let i = 0; i < 6; i++) {
    if (strip(CONJ)) continue;
    if (strip(VERB)) continue;
    break;
  }
  return norm(g);
}

// Lexical multiplier for one action's label vs the target phrase —
// bidirectional: agreement lifts, contradiction demotes, mystery caps.
//   exact              ×1.25  the goal's own wording confirms THIS element
//   prefix / contains  ×0.82 / ×0.68  sibling controls sharing the noun
//   readable, unrelated×0.55  text contradicts a concretely-named goal
//   no readable text   ×0.75  role-name fallback: cap the model's guess
function lexicalMultiplier(a, target) {
  if (!target || target.length < 2) return 1;
  if (!readable(a)) return 0.75;
  const l = norm(a.label);
  if (l === target) return 1.25;
  if (l.startsWith(target) || target.startsWith(l)) return 0.82;
  if (l.includes(target) || (target.includes(l) && l.length >= 2)) return 0.68;
  return 0.55;
}

// Does this action's wording AGREE with the goal's target phrase at all?
// exact / prefix / contains all count as agreement; an unrelated readable
// label or a role-name fallback (no text evidence) does not. The executor's
// goal-alignment gate uses this: a click_effect "pass" from an element that
// does not agree with the goal is not trusted when an agreeing candidate is
// available — that is how a wrong click derailing the plan gets caught.
export function goalAligned(a, target) {
  if (!target || target.length < 2) return true; // no usable noun -> no opinion
  if (!readable(a)) return false;
  const l = norm(a.label);
  const t = norm(target);
  if (!l || !t) return false;
  if (l === t) return true;
  if (l.startsWith(t) || t.startsWith(l)) return true;
  if (l.includes(t)) return true;
  return t.includes(l) && l.length >= 2;
}

// Mutates + sorts `routes` in place; returns them for convenience. Adds
// r.tie (size of the identical-label group) for the UI.
export function calibrateRoutes(routes, goal) {
  const target = targetOf(goal);
  for (const r of routes) {
    const a = r.action || {};
    let p = Number(r.score) || 0;
    p *= lexicalMultiplier(a, target);
    if (a.disabled) p *= 0.3;
    r.score = Math.max(0, Math.min(1, p));
  }
  const groups = new Map();
  for (const r of routes) {
    const key = norm(r.action?.label);
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  for (const r of routes) {
    const n = groups.get(norm(r.action?.label)) || 1;
    if (n > 1) {
      r.score = Math.max(0, Math.min(1, r.score / (1 + 0.35 * (n - 1))));
      r.tie = n;
    }
  }
  routes.sort((x, y) => y.score - x.score);
  return routes;
}
