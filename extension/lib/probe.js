// lib/probe.js — Phase 5 (A+B): target-aware DOM probe + group routing.
//
// Why this exists: in goal-driven mode the Controller (browser-use loop) only
// "sees" the flat interactive-element snapshot and discovers by clicking. On a
// real ERP sidebar with several collapsible groups it therefore expands groups
// one by one looking for e.g. "销售管理" — exactly the user's complaint.
//
// Fix: before the Controller wanders, we PROBE the live DOM directly:
//   - find every element whose text contains the sub-goal noun,
//   - report whether it is currently visible / in the viewport, and which
//     collapsible container hides it,
//   - list the sidebar group headers so we can route to the right one first.
// The interpreter then decides: click it directly (no wandering), expand the
// ONE container that owns it, or (if nothing matched) route by header text.
//
// Vision grounding (Phase 5-B) is the fallback when the DOM probe finds
// nothing actionable: a screenshot is sent to a vision model to locate the
// target, then clicked by coordinates. See lib/llm.js groundVision + background.

import { foldText } from "./calibrate.js";
import { IS_BUTTON_SRC } from "./dom-cues.js";

// Numeric lexical similarity for routing (0..1). Substring containment gives a
// strong base score; otherwise we fall back to character-bigram Jaccard so
// "销售管理" still ranks "销售" above unrelated headers. (Note: calibrate's
// goalAligned returns a boolean and expects {label} objects, so it can't be
// used directly for ranking raw strings here.)
function bigrams(s) {
  const o = new Set();
  for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2));
  return o;
}
function lexicalScore(a, b) {
  a = foldText(a || "");
  b = foldText(b || "");
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return 0.5 + 0.5 * (Math.min(a.length, b.length) / Math.max(a.length, b.length));
  }
  const ba = bigrams(a), bb = bigrams(b);
  let inter = 0;
  ba.forEach((x) => { if (bb.has(x)) inter++; });
  if (!ba.size || !bb.size) return 0;
  return inter / (ba.size + bb.size - inter);
}

// ---------- in-page probe (runs via CDP Runtime.evaluate) ----------
// Self-contained: references only page globals (document, window, getComputedStyle,
// NodeFilter). Serialized to a string and invoked as `PROBE_FN("noun")`.
function probeInPage(target) {
  // IS_BUTTON_HOOK — replaced at PROBE_FN build time with the canonical
  // isButtonLike source from lib/dom-cues.js, so this in-page walk shares the
  // snapshot collector's clickable definition verbatim.
  /*IS_BUTTON_HOOK*/
  const fold = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[\s 　]+/g, "")
      .replace(/[，,。.；;、：:!！?？"“”'‘’()（）\[\]【】<>《》\/\\|_\-]/g, "");
  const ft = fold(target);

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    return true;
  }
  // Hit-test occlusion: an element can pass every CSS visibility check yet be
  // UNDER a modal overlay (h3yun export dialog). A CDP click at its center
  // then lands on the overlay and silently does nothing — the engine kept
  // re-clicking the covered toolbar 导出 button while the export dialog was
  // open. The only trustworthy "clickable" is being the TOPMOST element at its
  // own center point (itself or a descendant).
  function isTopAtPoint(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cx = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
      const top = document.elementFromPoint(cx, cy);
      return !!top && (top === el || el.contains(top));
    } catch {
      return true; // elementFromPoint unavailable -> never break the probe
    }
  }
  // Shared with the snapshot collector: the SAME isButtonLike source is injected
  // below into probeInPage, so the probe and the collector never disagree on
  // what is clickable. EDIT ONLY lib/dom-cues.js — never re-diverge here.
  function clickableAncestor(el) {
    let n = el;
    while (n && n !== document.body) {
      if (isButtonLike(n)) return n;
      n = n.parentElement;
    }
    return null;
  }
  function containerOf(el) {
    // Nearest collapsible ancestor: aria-expanded toggle or a collapse/submenu
    // class, or a tree/group role. Returns a lightweight descriptor so the
    // Controller knows WHICH group to expand (not "some group").
    let n = el.parentElement;
    while (n && n !== document.body) {
      const role = n.getAttribute && n.getAttribute("role");
      const ae = n.getAttribute && n.getAttribute("aria-expanded");
      const cls = (n.className || "").toString();
      if (
        ae !== null ||
        /collapse|accordion|submenu|sub-menu|tree|nav-group|menu-group|sidebar-group/i.test(cls) ||
        role === "treeitem" ||
        role === "group"
      ) {
        return {
          label: (n.textContent || "").trim().slice(0, 40),
          ariaExpanded: ae,
        };
      }
      n = n.parentElement;
    }
    return null;
  }

  const hits = [];
  const seen = new Set();
  if (ft) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = walker.nextNode())) {
      const t = tn.textContent || "";
      if (t.length < 2) continue;
      if (fold(t).indexOf(ft) >= 0) {
        const anc = clickableAncestor(tn.parentElement || tn);
        if (anc && !seen.has(anc)) {
          seen.add(anc);
          const r = anc.getBoundingClientRect();
          hits.push({
            text: (anc.textContent || "").trim().slice(0, 40),
            visible: isVisible(anc),
            occluded: !isTopAtPoint(anc),
            inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0,
            rect: {
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              w: Math.round(r.width),
              h: Math.round(r.height),
            },
            container: containerOf(anc),
          });
        }
      }
    }
  }

  // Sidebar group headers (collapsible section titles). Used to route when the
  // target text is not present anywhere in the DOM yet.
  const headers = [];
  document
    .querySelectorAll(
      "[aria-expanded], .collapse-title, .nav-group__title, .nav-group-title, .menu-group > .title, .sidebar-section > h3, .sidebar-section > .header, .ant-menu-submenu-title, .el-submenu__title, .tree-node__label"
    )
    .forEach((h) => {
      headers.push({
        text: (h.textContent || "").trim().slice(0, 40),
        expanded: h.getAttribute ? h.getAttribute("aria-expanded") : null,
      });
    });

  return JSON.stringify({ hits: hits.slice(0, 30), headers: headers.slice(0, 50) });
}

// Inject the single-source clickable predicate so the in-page walk shares the
// snapshot collector's element model (no drift possible — it uses IS_BUTTON_SRC
// directly, not a hand-copied variant).
export const PROBE_FN = "(" + probeInPage.toString().replace("/*IS_BUTTON_HOOK*/", "const isButtonLike = (" + IS_BUTTON_SRC + ");") + ")";

// ---------- v0.4.30: lazy-load scroll sweep ----------
// Problem (taobao/tmall detail pages): review content (用户评价 body, 查看全部
// 评价 button) is LAZY-RENDERED — it only enters the DOM when the user scrolls
// near it. Both the snapshot collector and the viewport probe see a 45-element
// tree without it, the probe reports "no actionable hit", and the run wanders
// into Route/vision for an element that a scroll would reveal.
//
// Fix: an ASYNC in-page sweep that reuses PROBE_FN verbatim (zero drift) and,
// ONLY when the viewport walk found nothing usable, progressively scrolls the
// page, re-probes at each step, and stops at the first usable hit. Scroll is
// deliberately NOT restored when a hit is found: the returned coordinates are
// valid for an immediate CDP click at the CURRENT scroll position (the caller
// re-observes right after, so the snapshot picks up the newly rendered area).
// When nothing is found the original scroll position IS restored so the
// downstream vision/Route layers judge the page the step started on.
const SWEEP_BODY = `
  async (target, opts) => {
    opts = opts || {};
    const mode = opts.mode === "warm" || opts.mode === "random" ? opts.mode : "find";
    const maxSteps = opts.maxSteps > 0 ? opts.maxSteps : 6;
    const stepRatio = opts.stepRatio > 0 ? opts.stepRatio : 0.8;
    const waitMs = opts.waitMs == null ? 400 : opts.waitMs;
    const probeOnce = /*SWEEP_PROBE_HOOK*/;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const usable = (d) =>
      !!d && Array.isArray(d.hits) && d.hits.some((h) => h.visible && !h.occluded && h.inViewport);
    const dedupe = (arr) => {
      const seen = new Set(); const out = [];
      for (const h of (arr || [])) {
        const k = (h.text || "") + ":" + (h.rect ? h.rect.y : "");
        if (!seen.has(k)) { seen.add(k); out.push(h); }
      }
      return out;
    };
    const y0 = window.scrollY || 0;
    const vh = window.innerHeight || 800;
    const pageBottom = () => (document.documentElement && document.documentElement.scrollHeight) || 0;
    let last = null;
    let swept = 0;
    const agg = [];

    if (mode === "random") {
      // 随机滑动：跳到随机偏移触发懒加载，采集该处元素，停留（不回滚）。
      const maxY = Math.max(0, pageBottom() - vh);
      const ry = Math.floor(Math.random() * (maxY + 1));
      window.scrollTo(0, ry);
      if (waitMs) await sleep(waitMs);
      swept = 1;
      try { last = JSON.parse(probeOnce(target)); } catch (e) { last = null; }
      if (last && Array.isArray(last.hits)) agg.push(...last.hits);
      return JSON.stringify({ hits: dedupe(agg), headers: (last && last.headers) || [], swept, restored: false, warmed: true });
    }

    for (let i = 0; i < maxSteps; i++) {
      window.scrollBy(0, Math.round(vh * stepRatio));
      if (waitMs) await sleep(waitMs);
      swept = i + 1;
      let d = null;
      try { d = JSON.parse(probeOnce(target)); } catch (e) { d = null; }
      if (d && Array.isArray(d.hits)) agg.push(...d.hits);
      last = d;
      if (mode === "find" && usable(d)) {
        // 命中即停，停留在该位置（坐标对紧随的 CDP 点击即时有效）。
        return JSON.stringify({ hits: d.hits, headers: d.headers || [], swept, restored: false });
      }
      const y = window.scrollY || 0;
      if (y + vh >= pageBottom() - 2) break; // 已到页底
    }
    if (mode === "find") {
      // 未命中：回滚到原位置，留给 vision/Route 在原页面判断。
      window.scrollTo(0, y0);
      if (waitMs) await sleep(Math.min(waitMs, 120));
      return JSON.stringify({ hits: (last && last.hits) || [], headers: (last && last.headers) || [], swept, restored: true });
    }
    // warm：已在各位置触发懒加载，回滚到原位置（避免页面停在底部破坏顶部目标点击），
    // 聚合各屏命中的下方元素，交由调用方重采集快照后正常探针/扫描。
    window.scrollTo(0, y0);
    if (waitMs) await sleep(Math.min(waitMs, 120));
    return JSON.stringify({ hits: dedupe(agg), headers: (last && last.headers) || [], swept, restored: true, warmed: true });
  }
`;
// The sweep embeds the canonical PROBE_FN source — one walk implementation,
// two entry points, impossible to drift (same pattern as IS_BUTTON_HOOK).
export const SWEEP_FN = "(" + SWEEP_BODY.replace("/*SWEEP_PROBE_HOOK*/", PROBE_FN) + ")";

// Run the scroll sweep for `noun`. Returns { ok, data:{hits,headers,swept,restored} }.
export async function runProbeSweep(tabId, noun, opts) {
  if (!tabId) return { ok: false, error: "no tab" };
  return withDebugger(tabId, async (send) => {
    const expr = SWEEP_FN + "(" + JSON.stringify(noun || "") + "," + JSON.stringify(opts || {}) + ")";
    const r = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true, // the sweep is async (scroll + settle waits)
    });
    if (r && r.exceptionDetails) return { ok: false, error: String(r.exceptionDetails.text || "sweep eval") };
    const raw = r && r.result && r.result.value;
    let parsed = null;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      parsed = null;
    }
    return { ok: !!parsed, data: parsed };
  });
}

// ---------- CDP runners ----------
async function withDebugger(tabId, fn) {
  const dbg = { tabId };
  try {
    await chrome.debugger.attach(dbg, "1.3");
  } catch {
    /* already attached elsewhere; try anyway */
  }
  try {
    return await fn((m, p) => chrome.debugger.sendCommand(dbg, m, p));
  } finally {
    chrome.debugger.detach(dbg).catch(() => {});
  }
}

// Run the in-page probe for `noun`. Returns { ok, data:{hits,headers} } or { ok:false }.
export async function runProbe(tabId, noun) {
  if (!tabId) return { ok: false, error: "no tab" };
  return withDebugger(tabId, async (send) => {
    const expr = PROBE_FN + "(" + JSON.stringify(noun || "") + ")";
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (r && r.exceptionDetails) return { ok: false, error: String(r.exceptionDetails.text || "probe eval") };
    const raw = r && r.result && r.result.value;
    let parsed = null;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      parsed = null;
    }
    return { ok: !!parsed, data: parsed };
  });
}

export async function captureScreenshot(tabId) {
  if (!tabId) return { ok: false, error: "no tab" };
  return withDebugger(tabId, async (send) => {
    const r = await send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 60,
      captureBeyondViewport: false,
    });
    const data = r && r.data;
    return data ? { ok: true, data: "data:image/jpeg;base64," + data } : { ok: false, error: "no image" };
  });
}

export async function getViewport(tabId) {
  if (!tabId) return null;
  return withDebugger(tabId, async (send) => {
    const r = await send("Runtime.evaluate", {
      expression: "({w:window.innerWidth,h:window.innerHeight})",
      returnByValue: true,
    });
    const v = r && r.result && r.result.value;
    return v && typeof v === "object" ? v : null;
  });
}

// ---------- pure routing / interpretation (unit-testable) ----------
// Best-matching group header for a sub-goal noun. Returns {index,text,score,expanded} or null.
export function routeGroupByHeader(headers, noun) {
  const ft = foldText(noun || "");
  if (!ft || !headers || !headers.length) return null;
  let best = null;
  headers.forEach((h, i) => {
    const score = lexicalScore(ft, h.text || "");
    if (!best || score > best.score) best = { index: i, text: h.text, score, expanded: h.expanded };
  });
  return best && best.score > 0 ? best : null;
}

// Decide what to do from a probe result. Four modes:
//   click  -> target is visible in viewport: click its center directly.
//   expand -> target exists but hidden inside a container: expand THAT container.
//   route  -> nothing matched: expand the best-matching group header first.
//   none   -> probe inconclusive; let the vision fallback / Controller decide.
export function interpretProbe(probeData, noun) {
  if (!probeData || !probeData.hits) return { mode: "none" };
  const ft = foldText(noun || "");
  const scoreText = (t) => lexicalScore(ft, t || "");

  // Occluded hits (CSS-visible but under a modal overlay) are excluded from
  // BOTH buckets: clicking them lands on the overlay, and expanding a
  // collapsible container cannot lift an overlay. Old probe data without the
  // `occluded` field (undefined) keeps its previous behaviour.
  const visible = probeData.hits.filter((h) => h.visible && !h.occluded && h.inViewport && h.rect && h.rect.w > 0);
  if (visible.length) {
    visible.sort((a, b) => scoreText(b.text) - scoreText(a.text));
    // Score returned so the Controller can require a STRONG match before the
    // probe takes the click from a live jev decision (导出 -> 导出数据 is 0.75
    // and must not hijack; an exact 导出 === 导出 is 1.0).
    return { mode: "click", x: visible[0].rect.x, y: visible[0].rect.y, text: visible[0].text, score: scoreText(visible[0].text) };
  }

  const hidden = probeData.hits.filter((h) => !h.visible && !h.occluded && h.container);
  if (hidden.length) {
    hidden.sort((a, b) => scoreText(b.text) - scoreText(a.text));
    return { mode: "expand", containerLabel: hidden[0].container.label, ariaExpanded: hidden[0].container.ariaExpanded };
  }

  if (probeData.headers && probeData.headers.length) {
    const best = routeGroupByHeader(probeData.headers, noun);
    if (best) return { mode: "route", headerIndex: best.index, headerText: best.text, score: best.score };
  }
  return { mode: "none" };
}
