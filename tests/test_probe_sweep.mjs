/*
 * v0.4.30: lazy-load scroll sweep for the DOM probe.
 *
 * Symptom (taobao/tmall detail page): the review section (含「查看全部评价」)
 * is LAZY-RENDERED — it only enters the DOM/viewport when scrolled near. The
 * observation snapshot (45 elements) and the viewport probe both miss it, the
 * probe reports "无 actionable 命中", and the run wanders into Route/vision
 * for an element one scroll away.
 *
 * Fix: SWEEP_FN — an async in-page sweep that reuses PROBE_FN verbatim, scrolls
 * step-by-step (bounded), re-probes, and on a usable hit KEEPS the scroll
 * position (coordinates stay valid for the immediate CDP click); on failure it
 * restores the original scroll position. Arbitration gains rule 3: jev
 * confident but word-unaligned + STRONG probe hit -> probe wins.
 *
 * Run: node tests/test_probe_sweep.mjs   (needs jsdom)
 */
import { JSDOM } from "jsdom";
import { PROBE_FN, SWEEP_FN, interpretProbe } from "../extension/lib/probe.js";
import { decideExecutor } from "../extension/lib/probe-policy.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

// ---------- 0. build-time composition: the sweep embeds the canonical probe ----------
ok("SWEEP_FN embeds PROBE_FN verbatim (zero drift)", SWEEP_FN.includes(PROBE_FN));
ok("SWEEP_FN is syntactically valid", (() => { try { new Function("return " + SWEEP_FN); return true; } catch { return false; } })());

// ---------- jsdom harness with scroll + lazy-render simulation ----------
// The 查看全部评价 button sits at document offset top=1500 (below the 768px
// fold). Its rect is produced from the CURRENT simulated scrollY — before the
// page "scrolls" there it is out of viewport (inViewport=false), mimicking a
// below-fold lazy section.
const html = `<!doctype html><html><head></head><body>
  <button id="see-all">查看全部评价</button>
</body></html>`;
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://detail.tmall.com/item.htm" });
const { window } = dom;
const { document } = window;

const OFFSET_TOP = 1500, EL_H = 40, EL_X = 300, EL_W = 160;
window.__y = 0;
window.scrollBy = (dx, dy) => { window.__y += dy; };
window.scrollTo = (x, y) => { window.__y = y; };
Object.defineProperty(window, "scrollY", { get: () => window.__y, configurable: true });
Object.defineProperty(window, "innerHeight", { get: () => 768, configurable: true });
Object.defineProperty(document.documentElement, "scrollHeight", { get: () => 3000, configurable: true });
const btn = document.getElementById("see-all");
btn.getBoundingClientRect = () => {
  const top = OFFSET_TOP - window.__y;
  return { left: EL_X, top, width: EL_W, height: EL_H, right: EL_X + EL_W, bottom: top + EL_H, x: EL_X, y: top };
};
document.elementFromPoint = (x, y) => {
  const r = btn.getBoundingClientRect();
  if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return btn;
  return document.body;
};

const sweep = async (target, opts) => JSON.parse(await window.eval(SWEEP_FN)(target, opts));

// ---------- A. hit below the fold: sweep finds it and KEEPS the scroll ----------
const yAtStart = window.__y;
const hit = await sweep("查看全部评价", { waitMs: 1 });
ok("sweep finds the below-fold 查看全部评价", Array.isArray(hit.hits) && hit.hits.some((h) => (h.text || "").includes("查看全部评价")));
const hitRec = (hit.hits || []).find((h) => (h.text || "").includes("查看全部评价"));
ok("swept at least one screen", hit.swept >= 1);
ok("scroll NOT restored on a hit (coords valid for the immediate CDP click)", hit.restored === false && window.__y > yAtStart);
ok("hit is visible+unoccluded+inViewport at the scrolled position",
   hitRec && hitRec.visible === true && hitRec.occluded === false && hitRec.inViewport === true);
const interpHit = interpretProbe(hit, "查看全部评价");
ok("interpretProbe(sweep result) mode=click with exact score 1.0",
   interpHit.mode === "click" && interpHit.score === 1);

// ---------- B. target nowhere on the page: bounded sweep, scroll restored ----------
// Fresh page state: scenario A deliberately left the window scrolled (hit kept).
window.__y = 0;
const yBeforeMiss = window.__y;
const miss = await sweep("不存在的按钮", { waitMs: 1 });
ok("no hit anywhere -> hits empty", Array.isArray(miss.hits) && miss.hits.length === 0);
ok("no hit -> original scroll position restored", miss.restored === true && window.__y === yBeforeMiss);
ok("no hit -> sweep is bounded (stops at page bottom, ≤6 screens)", miss.swept >= 1 && miss.swept <= 6);
ok("interpretProbe(miss) mode=none", interpretProbe(miss, "不存在的按钮").mode === "none");

// ---------- C. viewport probe first, sweep only on miss (background wiring) ----------
// The viewport walk at scrollY=0 must NOT see the button (below fold)…
const viewportData = JSON.parse(window.eval(PROBE_FN + "(" + JSON.stringify("查看全部评价") + ")"));
ok("viewport PROBE_FN alone misses the below-fold element (why the sweep exists)",
   !viewportData.hits.some((h) => h.visible && h.inViewport));

// ---------- D. arbitration rule 3 (probe-policy v0.4.30) ----------
// jev confident (70%) on an unrelated "link" + probe EXACT hit -> probe wins.
ok("jev 70% unaligned + probe exact -> probe (lazy-load rescue)",
   decideExecutor({ jevHasDecision: true, jevTop: 0.7, probeScore: 1, lockBar: 0.6, jevAligned: false }) === "probe");
ok("jev 70% aligned + probe exact -> jev (v0.4.21 regression guard)",
   decideExecutor({ jevHasDecision: true, jevTop: 0.7, probeScore: 1, lockBar: 0.6, jevAligned: true }) === "jev");
ok("jevAligned undefined + jev 70% -> jev (legacy behaviour bit-for-bit)",
   decideExecutor({ jevHasDecision: true, jevTop: 0.7, probeScore: 1, lockBar: 0.6 }) === "jev");
ok("weak probe match 0.75 never hijacks an aligned-or-not jev decision",
   decideExecutor({ jevHasDecision: true, jevTop: 0.7, probeScore: 0.75, lockBar: 0.6, jevAligned: false }) === "jev");
ok("no jev decision + strong probe -> probe (rule 2 unchanged)",
   decideExecutor({ jevHasDecision: false, jevTop: 0, probeScore: 1, lockBar: 0.6 }) === "probe");

// ---------- E. warm mode: reveals below-fold content but RESTORES to top ----------
const yWarmStart = window.__y; // 0 (reset by scenario B)
const warm = await sweep("查看全部评价", { mode: "warm", waitMs: 1 });
ok("warm aggregates the below-fold 查看全部评价 across screens",
   Array.isArray(warm.hits) && warm.hits.some((h) => (h.text || "").includes("查看全部评价")));
ok("warm marks warmed:true", warm.warmed === true);
ok("warm restores to original top (never leaves page at bottom — protects top-target clicks)",
   warm.restored === true && window.__y === yWarmStart);
ok("warm is bounded (stops at page bottom, ≤6 screens)", warm.swept >= 1 && warm.swept <= 6);

// ---------- F. random mode: single random-offset nudge ----------
const rand = await sweep("查看全部评价", { mode: "random", waitMs: 1 });
ok("random marks warmed:true", rand.warmed === true);
ok("random does a single jump (swept === 1)", rand.swept === 1);
ok("random does NOT restore scroll (stays at the nudged offset)",
   rand.restored === false && window.__y !== 0);

console.log(`\n${fail ? "✗" : "✓"} test_probe_sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
