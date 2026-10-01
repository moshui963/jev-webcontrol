// lib/browseruse.js — browser-use-style agentic fallback for steps that jev/LLM
// ranking cannot settle (no candidate, or all candidates below the act bar, or
// out-of-scope actions like drag/pull/write/delete).
//
// Two operating modes:
//   1. Delegated backend (cfg.browserUseUrl set): POST the step goal + current
//      snapshot to a real browser-use service; it drives its own browser and
//      returns the executed action. This is the literal "引用 browser-use".
//   2. In-extension agentic loop (default): we repeatedly ask DeepSeek (via
//      llm.planOneAction) for the single next action, execute it on the live
//      tab through the content script, re-observe, and re-verify — the same
//      observe→act→observe loop browser-use uses, just running inside the
//      tester's own tab so it actually advances the user's page.
//
// Tab hygiene (v0.3.24): sites like taobao open every product/promo link with
// target="_blank". Without tracking, one failed click = one orphan tab, and a
// 6-iteration loop litters the window. Every tab opened by a FAILED attempt is
// closed before the next iteration; a successful attempt returns the tab the
// page state moved to so the engine can follow it.

import { planOneAction } from "./llm.js";
import { defaultSpecFor, fracOf, summarize } from "./verify.js";

const MAX_ITER = 6;
const PASS_FRAC = 0.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripped = (u) => String(u || "").split("#")[0];
const tabUrl = (tabId) =>
  new Promise((resolve) => {
    if (!tabId) return resolve(null);
    chrome.tabs.get(tabId, (t) => resolve(chrome.runtime.lastError ? null : t?.url || null));
  });

export async function browserUseFallback(ctx) {
  const { step, snap, tabId, cfg, sendToTab, waitForSettle, observeRetry, evaluateTab, goalFor,
          closeTab, ensureContentScript, shouldStop, actOnTab, goalOverride, probeHint } = ctx;
  // goalOverride (set in goal-driven mode) points the Controller at the full
  // objective + sub-goal progress instead of the narrow hypothesis step.
  const goal = goalOverride || goalFor(step);
  const close = (id) => { try { closeTab ? closeTab(id) : chrome.tabs.remove(id); } catch { /* ignore */ } };
  const closeAll = (ids) => { for (const id of ids || []) close(id); };
  const act = (tid, action, frameId) =>
    // CDP trusted click when available (h3yun ignores synthetic events);
    // otherwise the synthetic path. Target the frame that hosted the observed
    // snapshot first; broadcast only as a fallback.
    actOnTab
      ? actOnTab(tid, frameId, action)
      : sendToTab(tid, { type: "ACT", action }, frameId).then((r) =>
          (r && r.ok) ? r : sendToTab(tid, { type: "ACT", action }));

  // ---- mode 1: delegate to a real browser-use backend ----
  if (cfg.browserUseUrl) {
    try {
      const r = await fetch(cfg.browserUseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, snapshot: snap, step, url: snap?.url || "" }),
      });
      if (r.ok) {
        const data = await r.json().catch(() => null);
        if (data && data.ok) return { ok: true, note: "browser-use 后端执行成功", action: data.action };
      }
    } catch (e) {
      // fall through to the in-extension loop
      console.warn("[browseruse] 后端调用失败，回退到扩展内 agentic 循环:", e.message);
    }
  }

  // ---- mode 2: in-extension agentic loop ----
  let cur = snap;
  let lastAction = null;
  let ctxTab = tabId; // tab the agent keeps acting on (original working tab)
  const junk = new Set(); // tabs opened by failed attempts — closed on exit
  for (let i = 0; i < MAX_ITER; i++) {
    if (shouldStop?.()) { closeAll(junk); return { ok: false, note: "用户已停止" }; }
    let plan;
    try {
      plan = await planOneAction(cur, goal, lastAction, cfg, probeHint);
    } catch (e) {
      closeAll(junk);
      return { ok: false, note: "browser-use 决策失败: " + e.message };
    }
    if (plan.done) { closeAll(junk); return { ok: true, note: "browser-use 判定目标已完成" }; }
    const action = plan.action;
    if (action.kind === "fill") action.value = step.value || step.target || "";

    // Track tabs THIS action spawns (target=_blank / window.open).
    const spawned = [];
    const onCreated = (t) => spawned.push(t.id);
    try { chrome.tabs.onCreated.addListener(onCreated); } catch { /* ignore */ }
    const beforeUrl = (await tabUrl(ctxTab)) || cur?.url || "";
    const actRes = await act(ctxTab, action, ctxTab === tabId ? cur?.frameId : null);
    await sleep(800); // grace period for window.open to fire
    try { chrome.tabs.onCreated.removeListener(onCreated); } catch { /* ignore */ }
    if (!actRes || !actRes.ok) {
      closeAll(spawned);
      closeAll(junk);
      return { ok: false, note: "browser-use 执行失败: " + (actRes?.reason || "未知") };
    }

    // Where did the page state go? Same rule as execCandidate: the acting tab
    // navigated -> verify there; otherwise a spawned tab -> verify there.
    let resultTab = ctxTab;
    let extras = spawned;
    if (stripped(await tabUrl(ctxTab)) === stripped(beforeUrl) && spawned.length) {
      resultTab = spawned[spawned.length - 1];
      extras = spawned.filter((s) => s !== resultTab);
      await waitForSettle(resultTab, 9000);
    } else {
      await waitForSettle(ctxTab);
    }
    for (const s of extras) junk.add(s); // side tabs of this attempt

    if (resultTab !== ctxTab && ensureContentScript) await ensureContentScript(resultTab);
    const spec = defaultSpecFor(step, beforeUrl, cur);
    const ver = evaluateTab
      ? await evaluateTab(resultTab, spec, resultTab === ctxTab ? cur?.frameId : null)
      : await sendToTab(resultTab, { type: "EVALUATE", spec });
    const frac = fracOf(ver && ver.ok ? ver.result : null);
    if (frac >= PASS_FRAC) {
      closeAll(junk); // the attempt succeeded — junk from earlier failures goes
      return { ok: true, note: "browser-use 通过校验（" + (frac * 100).toFixed(0) + "%）", tabId: resultTab };
    }
    // Attempt failed: everything it opened is junk, including the spawned
    // result tab — the loop retries on the original context tab.
    if (resultTab !== ctxTab) junk.add(resultTab);
    const obs = await observeRetry(ctxTab);
    if (obs && obs.ok) cur = obs.state;
    lastAction = { kind: action.kind, label: action.label, verify: summarize(ver && ver.ok ? ver.result : null) };
  }
  closeAll(junk);
  return { ok: false, note: "browser-use 在迭代上限内未通过校验" };
}
