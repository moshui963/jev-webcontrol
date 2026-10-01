// lib/probe-policy.js — PURE arbitration between jev (the actor) and the DOM
// probe (a fallback that re-searches the live DOM for a target noun).
//
// ARCHITECTURE (why this is a separate, pure function):
//   jev decides from the snapshot collector's candidate model (occlusion-filtered,
//   locator-resolved, scored). The probe decides from an independent text walk.
//   They will disagree sometimes, so WHO gets to click must be ONE explicit,
//   testable policy rather than magic numbers buried in background.js.
//
// RULES
//   1. If jev produced a usable decision (top >= lockBar) -> jev wins. The probe
//      is a fallback, never an override. (This is what stopped the "probe clicked
//      the inert dialog TITLE while jev's 82% candidate was the real button" loop.)
//   2. If jev has NO usable decision, the probe may take over ONLY when its best
//      hit is a STRONG match (score >= 0.8). A loose containment match like
//      导出 -> 导出数据 (0.75) must NOT hijack.
//   3. v0.4.30: jev confident BUT word-unaligned with the step's target AND the
//      probe hit is STRONG (>= 0.8) -> probe wins. This is the lazy-load sweep
//      case: the below-fold target never entered jev's snapshot, so jev's 70%
//      pick is some unrelated "link"; a probe EXACT hit on 查看全部评价 (1.0)
//      must not be suppressed by that noise. When `jevAligned` is undefined the
//      legacy behaviour is preserved bit-for-bit (existing runs/tests).
//   4. Otherwise -> "none": hand off to vision / Route / escalate; never blind-click.
//
// `lockBar` is operator-tunable (功能配置: 探针接管临界); default 0.6 keeps the
// historical behaviour. Higher = trust jev more, probe intervenes less.
export function decideExecutor({ jevHasDecision, jevTop = 0, probeScore = 0, lockBar = 0.6, jevAligned } = {}) {
  const bar = typeof lockBar === "number" && lockBar > 0 && lockBar <= 1 ? lockBar : 0.6;
  const top = typeof jevTop === "number" ? jevTop : 0;
  const pScore = typeof probeScore === "number" ? probeScore : 0;
  if (jevHasDecision && top >= bar) {
    if (jevAligned === false && pScore >= 0.8) return "probe"; // v0.4.30 rule 3
    return "jev";
  }
  if (!jevHasDecision && pScore >= 0.8) return "probe";
  return "none";
}
