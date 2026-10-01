// Tests for Phase 3 governance + goal-done detection (lib/governance.js) and the
// goal ingestion shape used by the agentic (one-sentence) mode (lib/goal.js).
// Pure node ESM — no extension/chrome runtime needed.
import {
  pageSig, snapModalCount, goalSuccessFired, checkStuck, stuckQuestion, STAGNANT_LIMIT, REPEAT_LIMIT,
} from "../extension/lib/governance.js";
import { parseGoal, extractNouns, inferSuccess } from "../extension/lib/goal.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.error("  ✗ " + name); } };

// ---------- pageSig ----------
const snapA = { url: "u", title: "t", actions: [{ label: "氚云" }, { label: "合同订单" }] };
const snapB = { url: "u", title: "t", actions: [{ label: "氚云" }, { label: "导出" }] };
ok("pageSig differs when page changes", pageSig(snapA) !== pageSig(snapB));
ok("pageSig stable for same page", pageSig(snapA) === pageSig({ ...snapA }));

// ---------- snapModalCount ----------
ok("no modal -> 0", snapModalCount(snapA) === 0);
ok("modal flagged by role", snapModalCount({ actions: [{ role: "dialog" }] }) === 1);
ok("modal flagged by .modal", snapModalCount({ actions: [{ modal: true }] }) === 1);
ok("null snap -> 0", snapModalCount(null) === 0);

// ---------- goalSuccessFired: download ----------
ok("download not fired -> false", goalSuccessFired({ signal: "download" }, { downloadFired: false }) === false);
ok("download fired -> true", goalSuccessFired({ signal: "download" }, { downloadFired: true }) === true);

// ---------- goalSuccessFired: dialogClosed ----------
const diaCtx = (acted, modal) => ({
  controllerHistory: acted ? ["导出"] : [],
  history: [],
  lastState: { actions: modal ? [{ role: "dialog" }] : [] },
});
ok("dialogClosed: export done + dialog open -> false", goalSuccessFired({ signal: "dialogClosed" }, diaCtx(true, true)) === false);
ok("dialogClosed: export done + no dialog -> true", goalSuccessFired({ signal: "dialogClosed" }, diaCtx(true, false)) === true);
ok("dialogClosed: nothing done -> false", goalSuccessFired({ signal: "dialogClosed" }, diaCtx(false, false)) === false);

// ---------- goalSuccessFired: elementClicked ----------
const ecSnap = { actions: [{ kind: "click", label: "合同订单", disabled: false }] };
ok("elementClicked: target present -> true", goalSuccessFired({ signal: "elementClicked", value: "合同订单" }, { lastState: ecSnap, subGoalNoun: "合同订单" }) === true);
ok("elementClicked: target absent -> false", goalSuccessFired({ signal: "elementClicked", value: "合同订单" }, { lastState: { actions: [] }, subGoalNoun: "合同订单" }) === false);

// ---------- checkStuck ----------
ok("fresh run not stuck", checkStuck({ stagnantStreak: 0, repeatActionStreak: 0 }).stuck === false);
ok(`stagnant >= ${STAGNANT_LIMIT} stuck`, checkStuck({ stagnantStreak: STAGNANT_LIMIT, repeatActionStreak: 0, subGoalNoun: "导出" }).stuck === true);
ok(`repeat >= ${REPEAT_LIMIT} stuck`, checkStuck({ stagnantStreak: 0, repeatActionStreak: REPEAT_LIMIT }).stuck === true);
const r = checkStuck({ stagnantStreak: STAGNANT_LIMIT, repeatActionStreak: 0 }, "导出");
ok("stuck reason names sub-goal", r.reason.includes("导出"));

// ---------- stuckQuestion ----------
ok("stuckQuestion mentions sub-goal", stuckQuestion("合同订单", "x").includes("合同订单"));
ok("stuckQuestion mentions 我已处理", stuckQuestion("x", "y").includes("我已处理"));

// ---------- goal ingestion shape (used by SET_GOAL) ----------
const extracted = extractNouns("在氚云页面找到合同订单导出所有合同");
ok("extractNouns strips glue words (no 页面)", !extracted.includes("页面"));
ok("extractNouns keeps 氚云/合同订单/导出", extracted.includes("氚云") && extracted.includes("合同订单") && extracted.includes("导出"));

const inf = inferSuccess("在氚云页面找到合同订单导出所有合同");
ok("inferSuccess -> dialogClosed", inf.signal === "dialogClosed");
ok("inferSuccess download beats export (下载报表)", inferSuccess("下载这份报表").signal === "download");

const g = await parseGoal("在氚云页面找到合同订单导出所有合同", { deepseekKey: "" });
ok("parseGoal yields subGoals", Array.isArray(g.subGoals) && g.subGoals.length >= 2);
ok("parseGoal subGoals include 合同订单", g.subGoals.some((s) => s.noun === "合同订单"));
ok("parseGoal has successCriteria", !!g.successCriteria && !!g.successCriteria.signal);
ok("parseGoal has steps", Array.isArray(g.steps) && g.steps.length >= 1);

console.log(`\nPhase 3/4 logic tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
