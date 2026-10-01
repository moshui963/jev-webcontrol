// lib/dom-cues.js — SINGLE SOURCE OF TRUTH for "what is a clickable control".
//
// WHY THIS FILE EXISTS
// --------------------
// The extension has TWO page engines that each need to decide "is this element
// something the user can click":
//   1. the snapshot collector (content/snapshot_injected.js) — feeds jev;
//   2. the DOM probe (lib/probe.js, runs PROBE_FN in-page) — the execution-time
//      fallback that re-searches the live DOM for a target noun.
//
// They used to keep SEPARATE, drifting definitions. The probe missed the ERP
// dialog's cursor:pointer styled-div confirm button (which the snapshot
// collector saw, so jev's candidate list had it) and instead clicked an inert
// containment match (dialog TITLE "导出数据"). That whole class of bug is caused
// by two parallel element models. The fix is architectural, not a patch: ONE
// predicate, injected VERBATIM into both engines, with a regression test
// (tests/test_dom_cues.mjs) that fails if the embedded copies ever diverge.
//
// This function is self-contained (no imports) so it can run inside a page.
export function isButtonLikeSrc(e) {
  try {
    const t = (e.tagName || "").toUpperCase();
    const role = e.getAttribute && e.getAttribute("role");
    const cls = ((e.getAttribute && e.getAttribute("class")) || "").toLowerCase();
    const classIsBtn = /\b(button|btn|ant-btn|ant-btn-primary|ant-btn-text|el-button|ivu-btn)\b/.test(cls);
    let pointer = false;
    try { pointer = getComputedStyle(e).cursor === "pointer"; } catch (e2) { /* detached node */ }
    if (
      t === "A" || t === "BUTTON" ||
      role === "button" || role === "menuitem" || role === "option" ||
      e.onclick || (e.getAttribute && e.getAttribute("tabindex") === "0") ||
      classIsBtn || pointer
    ) {
      return true;
    }
  } catch (e3) { /* noop */ }
  return false;
}

// The function source, injected into both in-page engines so they share it.
export const IS_BUTTON_SRC = isButtonLikeSrc.toString();
