// lib/replan.js — Phase 6: deterministic reflective re-planner.
//
// This is the "live plan" brain that turns the static 5-step hypothesis from
// goal.js into a plan that GROWS and SHRINKS at run time — exactly what the
// user needs for a sub-goal like "导出" that is really a multi-level action
// sequence (导出 → 导出全部数据 → 弹窗点导出).
//
// Design (architecture, not a patch):
//   - The plan stays a FLAT `steps[]` so the existing sequential engine keeps
//     working unchanged. Each step carries a `subGoal` anchor + `kind`
//     (`"goal-entry"` = top-level sub-goal, `"refined"` = inserted child step).
//   - After every step we run ONE pure function `replan(ctx)` that returns edit
//     instructions ({append, drop}). runLoop applies them. No scattered if/else.
//   - Growth (append): when an ACTION-type sub-goal entry is executed and the
//     page reveals related buttons (a dialog/menu), those become refined child
//     steps spliced right after the entry. Each child, when executed, can in
//     turn reveal the next level — natural recursive expansion, no pre-expand.
//   - Shrinkage (drop): once the sub-goal's target view is reached, the rest of
//     that sub-goal's not-yet-run refined steps are pruned (redundancy cut).
//   - De-dup on append by folded target text prevents the same button being
//     appended repeatedly across levels.
//
// All sensing reuses existing wheels: `targetPresent` (calibrate),
// `goalSuccessFired`/`pageSig` (governance). No new LLM calls, no new CDP — the
// "relevant buttons" come straight from the snapshot's `actions` list the
// content script already produced.

import { goalSuccessFired, pageSig } from "./governance.js";
import { foldText } from "./calibrate.js";

// Sub-goal verbs whose execution opens a multi-level UI (dialog/menu/sub-form)
// and therefore must be expanded into child steps at run time.
const EXPAND_VERBS = ["导出", "下载", "保存", "提交", "录入", "上传", "发送", "确认", "新建", "添加", "筛选", "查询"];

export function isExpandableVerb(verb) {
  const fv = foldText(verb || "");
  return EXPAND_VERBS.some((v) => fv.includes(foldText(v)));
}

// Pull the clickable candidates from a snapshot that are semantically related to
// `noun` (the sub-goal). We keep elements whose label shares the sub-goal's
// word root OR contains it — e.g. sub-goal "导出" matches "导出全部数据".
// Scrolling/waiting/inputs are skipped; disabled elements too.
export function relatedActions(snap, noun) {
  if (!snap || !snap.actions) return [];
  const ft = foldText(noun || "");
  const seen = new Set();
  const out = [];
  for (const a of snap.actions) {
    if (a.kind && /^(scroll|wait|input|fill|type)$/.test(a.kind)) continue;
    if (a.disabled) continue;
    const fl = foldText(a.label || "");
    if (!fl) continue;
    const related = ft && (fl.includes(ft) || ft.includes(fl));
    if (related && !seen.has(fl)) {
      seen.add(fl);
      out.push({ label: a.label, kind: a.kind || "click" });
    }
  }
  return out;
}

// When a click opens a NEW dialog (e.g. "导出全部数据" → a confirm dialog with
// 「确定 / 取消」), the next action is NOT a name-match of the sub-goal noun but
// a generic affirmative verb. This returns the clickable candidates that look
// like the dialog's confirm/submit button — used to keep expanding a
// multi-level flow past the first dialog, without per-case patches.
const AFFIRM_VERBS = /(确定|确认|提交|保存|开始|导出|下载|生成|是|ok|yes)/i;
export function dialogAffirmActions(snap, noun) {
  if (!snap || !snap.actions) return [];
  const ft = foldText(noun || "");
  const seen = new Set();
  const out = [];
  for (const a of snap.actions) {
    if (a.kind && /^(scroll|wait|input|fill|type)$/.test(a.kind)) continue;
    if (a.disabled) continue;
    const fl = foldText(a.label || "");
    if (!fl) continue;
    const related = ft && (fl.includes(ft) || ft.includes(fl));
    const affirm = AFFIRM_VERBS.test(a.label || "");
    if ((related || affirm) && !seen.has(fl)) {
      seen.add(fl);
      out.push({ label: a.label, kind: a.kind || "click" });
    }
  }
  return out;
}

// Scope qualifiers that make menu items MUTUALLY EXCLUSIVE alternatives:
// 导出全部数据 vs 导出已选数据 vs 导出当前页 — clicking both is wrong (one
// runs with the wrong scope, the other usually toasts an error and closes the
// menu). Which alternative is wanted is GOAL-level information the reflector
// previously didn't see (the LLM planner has it; replan didn't). We now read
// the scope wording straight from the user's goal text: 「所有/全部」→ 全部
// alternatives, 「已选/选中」→ selected ones, 「当前页」→ this page. If the goal
// names no scope, nothing is narrowed (we can't know) — all alternatives stay.
const SCOPE_PREFS = [
  { want: /所有|全部|全量|全数据/, labels: /全部|所有|全量/ },
  { want: /已选|选中|勾选|所选|选定/, labels: /已选|选中|勾选|所选|选定/ },
  { want: /当前页|本页|此页/, labels: /当前页|本页|此页/ },
];

// Narrow a list of {label, kind} (or step drafts) to the scope the goal asks
// for. Returns the input unchanged when the goal names no known scope or no
// label matches — never narrows to empty.
export function filterByGoalScope(items, goalText) {
  const g = foldText(goalText || "");
  if (!g) return items;
  for (const p of SCOPE_PREFS) {
    if (!p.want.test(g)) continue;
    const hit = items.filter((it) => p.labels.test(foldText(it.label || it.target || "")));
    if (hit.length && hit.length < items.length) return hit;
  }
  return items;
}

// The deterministic reflector. Pure & runtime-free so it can be unit-tested
// without the service-worker. Returns edit instructions for runLoop to apply.
//
//   ctx = {
//     steps, idx, snap, subGoalNoun,
//     successCriteria, controllerHistory, history, downloadFired,
//     lastPageSig,
//   }
export function replan(ctx) {
  const {
    steps, idx, snap, subGoalNoun, successCriteria,
    controllerHistory, history, downloadFired, lastPageSig, goalText, prevSnap,
  } = ctx;
  const edits = { append: [], drop: [], jumpTo: null, note: "" };
  const cur = steps[idx];

  if (!cur) return edits;

  // ---- SHRINK guard: if the GOAL's success signal already fired, the whole run
  // is done — handled by Phase 3, but re-affirm here so a caller that skips
  // Phase 3 still stops. ----
  if (
    successCriteria &&
    goalSuccessFired(successCriteria, { lastState: snap, downloadFired, controllerHistory, history, subGoalNoun })
  ) {
    edits.done = true;
    edits.note = "成功信号命中（replan 复核）";
    return edits;
  }

  // ---- GROW: a step just executed and may have revealed a multi-level UI. ----
  // Works for BOTH top-level sub-goals (expandable goal-entries) AND refined
  // child steps: if a refined click MOVED the page and we're not done, keep
  // expanding into whatever dialog/options appeared — so a 2nd-level "确定"
  // confirm button also gets clicked. De-dup (global existTargets) prevents
  // infinite loops; `cur.expanded` marks a step already processed; the goal's
  // success signal (download) is the terminator. This is why
  // 「点击 导出 → 点击 导出全部数据 → 点确认下载」 now completes.
  if ((cur.expandable || cur.kind === "refined") && !cur.expanded && subGoalNoun) {
    const pageChanged = !!lastPageSig && pageSig(snap) !== lastPageSig;
    // goal-entry: grow whenever expandable (the dialog reveal is the whole point).
    // refined: grow only when the click actually moved the page AND we're not done.
    if (cur.expandable || (pageChanged && !downloadFired)) {
      const relAll = cur.expandable ? relatedActions(snap, subGoalNoun) : dialogAffirmActions(snap, subGoalNoun);
      // Scope narrowing (全部/已选/当前页) only applies at the FIRST-level export
      // menu where sibling range options compete. A 2nd-level confirm dialog's
      // 「确定/取消」 must NOT be scope-narrowed — we always want the affirmative
      // button, never 「取消」, regardless of the goal's range wording.
      const rel = cur.expandable ? filterByGoalScope(relAll, goalText) : relAll;
      const existTargets = new Set(steps.map((s) => foldText(s.target || "")));
      for (const r of rel) {
        const ft = foldText(r.label);
        if (existTargets.has(ft)) continue; // de-dup (global)
        existTargets.add(ft);
        edits.append.push({
          afterIdx: idx,
          intent: "点击 " + r.label,
          verb: "click",
          target: r.label,
          subGoal: subGoalNoun,
          kind: "refined",
          expandOf: idx,
          expandable: false,
        });
      }
      if (edits.append.length) {
        edits.note = `细化「${subGoalNoun}」→ 追加 ${edits.append.length} 个子步骤`;
      } else {
        // Nothing relevant on the page — mark expanded anyway so we never retry
        // infinitely on a sub-goal that simply has no further UI (e.g. a direct
        // download that fired without a dialog).
        cur.expanded = true;
        edits.note = `「${subGoalNoun}」无后续 UI，标记已细化`;
      }
    }
  }

  // ---- SHRINK: de-duplication ONLY. A multi-level flow (导出 → 导出已选数据
  // → 导出当前页 → 导出数据(xlsx)） keeps the sub-goal's own button on EVERY
  // level — the inner dialog's final confirm button is often literally "导出".
  // So `targetPresent(snap, subGoalNoun)` is TRUE at each step, and a loose
  // "drop all remaining siblings" rule would prune the still-needed child steps
  // and end the run BEFORE the goal's success signal (download fired) ever
  // fires — exactly the premature-stop bug. We therefore only drop siblings
  // that are EXACT duplicates of the step just executed (same folded target).
  // Distinct siblings stay; the goal's success criterion is the only legitimate
  // terminator, so the run keeps clicking 导出当前页 / 导出数据(xlsx) until the
  // download actually fires. ----
  if (cur.kind === "refined" && cur.expandOf != null && subGoalNoun) {
    const curFt = foldText(cur.target || "");
    if (curFt) {
      const dups = steps
        .map((s, i) => ({ s, i }))
        .filter(
          ({ s, i }) =>
            i > idx &&
            s.expandOf === cur.expandOf &&
            s.status !== "done" &&
            s.status !== "dropped" &&
            foldText(s.target || "") === curFt
        );
      if (dups.length) {
        edits.drop.push(...dups.map(({ i }) => i));
        edits.note = `「${subGoalNoun}」已点击「${cur.target}」，裁剪 ${dups.length} 个重复子步骤`;
      }
    }
  }

  // ---- SHRINK: drift recovery. If the page signature diverged from the prior
  // step AND this was a refined step AND nothing legitimate happened, rewind to
  // the last stable sub-goal entry instead of forging ahead on a wrong page. ----
  // Crucial guard: a refined click that TRIGGERS A DOWNLOAD (success) or that the
  // GROW pass just turned into more child steps (edits.append) is NOT a deviation
  // — the old rule aborted the whole export run the instant "导出全部数据" was
  // clicked, because the popup closed. We must not rewind on those.
  if (lastPageSig && pageSig(snap) !== lastPageSig && cur.kind === "refined" && !edits.append.length && !downloadFired) {
    for (let i = idx; i >= 0; i--) {
      const s = steps[i];
      if (s && s.kind === "goal-entry" && s.status === "done") {
        // Rewind to the parent entry (not i+1, which overshoots past the refined
        // step and terminates the run via "步骤耗尽").
        edits.jumpTo = i;
        edits.note = "页面偏离预期，回退到稳定检查点";
        break;
      }
    }
  }

  return edits;
}
