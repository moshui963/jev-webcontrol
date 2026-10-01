// lib/verify.js — verification spec helpers (ported spirit from scripts/verify.py).

// Build a declarative spec for a step. navigate steps check URL; fill steps
// check the input box VALUE (page body text is full of distractors — Baidu
// suggestions contain the keyword, so text_contains false-positives); search
// steps require BOTH the keyword in an input AND the results-page URL; click
// steps fall back to page text (weak but better than nothing).
//
// beforeUrl: the page URL captured BEFORE the action ran. For click steps on
// search/submit buttons the target string is usually an AI paraphrase
// ("搜索按钮（搜索提交按钮）") that never appears as page text — text_contains
// then can NEVER pass, even when the click worked and navigated to the results
// page. For those clicks the real evidence is a URL change, so we swap the
// check to url_changed(from=beforeUrl).
//
// beforeState: the pre-action page snapshot (optional). Clicks that open a
// MODAL/drawer (导出全部数据 -> 导出弹窗) change neither the URL nor keep the
// clicked label in the DOM (the dropdown closes) — the third signal is a
// visible DOM change vs. the pre-action fingerprint.
export function defaultSpecFor(step, beforeUrl, beforeState) {
  const target = (step && step.target) || "";
  // Judgment-layer resolution: jev/LLM committed to the real on-page element
  // (e.g. "用户评价" for goal "评论") and stamped it on step.resolvedLabel.
  // Verify against THAT — not a literal re-match of the goal noun, and no
  // synonym table. Fall back to the literal target only when no resolution yet.
  const resolvedText = (step && step.resolvedLabel) || target;
  const checks = [];
  if (step?.verb === "navigate" && step.url) {
    checks.push({ type: "url_matches", regex: escapeRegex(step.url) });
  } else if (step?.verb === "search" && (step.value || target)) {
    // v0.4.27: the KEYWORD lives in step.value (goal-mode steps carry
    // target=搜索框 / value=投影灯). Checking `target` would search every
    // input for the literal string "搜索框" and can never pass.
    const kw = step.value || target;
    checks.push({ type: "input_value", text: kw });
    checks.push({ type: "url_contains", text: kw });
  } else if (step?.verb === "fill" && (step.value || target)) {
    checks.push({ type: "input_value", text: step.value || target });
  } else if (target) {
    const isSubmitClick =
      /搜索|查询|submit|search|百度一下/i.test((step?.intent || "") + " " + target);
    if (beforeUrl) {
      // For clicks WITH a known starting URL the evidence that the click
      // landed is: the URL changed (same-tab navigation OR a target=_blank
      // spawned tab) OR the target text shows up in the page OR the DOM
      // visibly changed vs. the pre-action snapshot (a modal opened).
      const before = beforeState
        ? {
            // Legacy baseline: actions also contains scroll/wait, select
            // options and "Open X" duplicates — keep for old snapshots only.
            actions: (beforeState.actions || []).length,
            // Apples-to-apples baselines captured by snapshot_injected.run():
            // raw collectCandidates length, uncapped rendered text length and
            // the visible modal/overlay count (modal-opened detection).
            candCount: Number.isFinite(beforeState.candCount) ? beforeState.candCount : undefined,
            bodyTextLen: Number.isFinite(beforeState.bodyTextLen)
              ? beforeState.bodyTextLen
              : beforeState.textLen ?? (beforeState.text || "").length,
            dialogs: Number.isFinite(beforeState.dialogs) ? beforeState.dialogs : undefined,
          }
        : undefined;
      checks.push({ type: "click_effect", text: isSubmitClick ? "" : resolvedText, from: beforeUrl, before });
    } else {
      checks.push({ type: "text_contains", text: resolvedText });
    }
  }
  return { verification: checks };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Fraction (0..1) of passed checks; empty spec → neutral 0.5.
export function fracOf(result) {
  if (!result || !Array.isArray(result.checks) || !result.checks.length) return 0.5;
  const passed = result.checks.filter((c) => c.ok).length;
  return passed / result.checks.length;
}

// Summarize an evaluateSpec result into a short human string.
export function summarize(result) {
  if (!result) return "no result";
  const passed = result.passed ? "PASS" : "FAIL";
  const details = (result.checks || []).map((c) => `${c.type}:${c.ok ? "✓" : "✗"}`).join(" ");
  return `${passed} | ${details}`;
}
