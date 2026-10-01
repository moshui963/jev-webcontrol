// lib/governance.js — Phase 3 loop governance + explicit goal-done detection.
//
// Pure, runtime-free helpers so the "stop & ask human when stuck" and "success
// signal = done" logic can be unit-tested without the extension/service-worker
// environment. background.js owns the `state` object and calls into these
// functions, passing the bits of state each one needs.

import { targetPresent } from "./calibrate.js";

// (targetPresent is re-exported by calibrate.js; re-export here too so callers
// that only need governance helpers don't have to reach into calibrate.)
export { targetPresent };

// Thresholds for the loop-governance guard.
export const STAGNANT_LIMIT = 3; // N consecutive steps with an unchanged page
export const REPEAT_LIMIT = 4;   // N consecutive steps repeating the same action

// A stable signature of "what the page currently is". Two identical signatures
// across steps => the Controller is spinning without advancing the page.
export function pageSig(snap) {
  if (!snap) return "";
  const labels = (snap.actions || [])
    .slice(0, 40)
    .map((a) => (a.label || a.role || "") + (a.disabled ? "!" : ""));
  return (snap.url || "") + "|" + (snap.title || "") + "|" + labels.join(",");
}

// How many modal/dialog overlays are open right now. A non-zero count means an
// export/submit dialog is still up — required to know when dialogClosed fired.
export function snapModalCount(snap) {
  if (!snap || !snap.actions) return 0;
  return snap.actions.filter(
    (a) => a.modal || /dialog|modal|弹窗|对话框/i.test(a.role || a.kind || "")
  ).length;
}

// Has the GOAL's success criterion actually been met? Called after every step in
// goal mode; when true the whole run is complete.
//   ctx = { lastState, downloadFired, controllerHistory, history, subGoalNoun }
export function goalSuccessFired(criteria, ctx) {
  if (!criteria) return false;
  const sig = criteria.signal;
  const snap = ctx.lastState;
  if (sig === "download") return !!ctx.downloadFired;
  if (sig === "dialogClosed") {
    const acted =
      (ctx.controllerHistory || []).some((h) => /导出|下载|保存|提交/.test(h)) ||
      (ctx.history || []).some((h) => /导出|下载|保存|提交/.test(h.action?.label || ""));
    return acted && snapModalCount(snap) === 0; // export triggered AND no dialog lingering
  }
  // Match against the JUDGMENT-LAYER's resolved term, not the literal goal
  // noun. jev/LLM (judgment layer) picked the real on-page element and stamped
  // it onto criteria.resolvedValue; fall back to the literal noun only when no
  // resolution happened. No synonym table — recognition lives in one place.
  const noun = criteria.resolvedValue || criteria.value || ctx.subGoalNoun;
  if (!noun) return false;
  if (sig === "textPresent") {
    // Content appeared: the resolved on-page term is a unique click target,
    // or the captured body text now contains it.
    return (
      targetPresent(snap, noun) ||
      (snap && snap.text ? snap.text.includes(noun) : false)
    );
  }
  return targetPresent(snap, noun);
}

// Returns { stuck, reason } for the loop-governance guard. `run` carries the
// streak counters; `subGoalNoun` labels the spot we're stuck on in the reason.
export function checkStuck(run, subGoalNoun) {
  if (!run) return { stuck: false };
  if ((run.stagnantStreak || 0) >= STAGNANT_LIMIT)
    return { stuck: true, reason: `页面连续 ${STAGNANT_LIMIT} 步未变化（卡在「${subGoalNoun || "?"}」附近）` };
  if ((run.repeatActionStreak || 0) >= REPEAT_LIMIT)
    return { stuck: true, reason: `连续 ${REPEAT_LIMIT} 步重复同一动作` };
  return { stuck: false };
}

// The question surfaced to the human when the loop is stuck.
export function stuckQuestion(subGoalNoun, reason) {
  return (
    `执行卡住：${reason}。当前子目标「${subGoalNoun || "?"}」可能不存在、已更名，或需要人工先操作（如登录/切换组织）。` +
    `请处理后再点「我已处理」继续；若目标描述有误，可在 Agent 重新描述一句话目标。`
  );
}
