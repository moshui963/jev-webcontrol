/*
 * Regression test (v0.4.15): popup/hover-card MENU WRAPPER collapse.
 *
 * Symptom (百家号"新的创作"弹窗): the element tree showed a single button whose
 * label was the CONCATENATION of all menu item texts ("文章 文章 选择已有内容
 * … 新的创作") and none of the actual menu items (文章/贴图/视频/…) — the
 * wrapper was collected first (document order) and the heuristic's hoisted
 * check swallowed every item below it. Fix: isMenuWrapper() prunes weak
 * (role-less) wrappers containing >=3 distinct innermost text leaves and no
 * real controls, in BOTH collection passes.
 *
 * Run: node tests/test_menu_wrapper.mjs   (needs jsdom)
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = readFileSync(join(__dirname, "..", "extension", "content", "snapshot_injected.js"), "utf8");

const html = `<!doctype html><html><head></head><body>
  <button id="main-btn">Main Button</button>
  <!-- hover-card wrapper: matched by the FIRST pass via [onclick]; wraps a
       pure-div menu (no roles, no links) -> must be pruned so the heuristic
       collects each item instead -->
  <div id="menu" class="pointer" onclick="">
    <div class="item pointer"><img><span>文章</span></div>
    <div class="item pointer"><img><span>选择已有内容</span></div>
    <div class="item pointer"><img><span>贴图</span></div>
    <div class="item pointer"><img><span>视频</span></div>
    <div class="item pointer"><img><span>播客</span></div>
  </div>
  <!-- regression guard 1: weak [onclick] control with a SINGLE text leaf must stay -->
  <div id="solo" class="pointer" onclick=""><span>普通操作</span></div>
  <!-- regression guard 2: wrapper containing REAL controls (links) must stay -->
  <div id="row" class="pointer" onclick=""><span>行标题</span><a href="#" id="row-link">详情</a><a href="#">编辑</a></div>
</body></html>`;

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://app.example.com/" });
const { window } = dom;

// --- stubs so run() can produce actions under jsdom ---
window.Element.prototype.checkVisibility = function () { return true; };
window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 };
};
window.document.createRange().constructor.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
};
// jsdom does not implement innerText; textContent is a faithful stand-in here.
Object.defineProperty(window.HTMLElement.prototype, "innerText", {
  get() { return this.textContent; },
  configurable: true,
});
// effectiveRole() reads computed cursor: elements marked .pointer behave as buttons.
window.getComputedStyle = (el) => ({ cursor: el && el.classList && el.classList.contains("pointer") ? "pointer" : "" });

const script = window.document.createElement("script");
script.textContent = SNAPSHOT;
window.document.body.appendChild(script);

const api = window.__jevSnapshotExt;
if (!api || typeof api.run !== "function") {
  console.error("FAIL: snapshot_injected.js did not expose window.__jevSnapshotExt.run");
  process.exit(1);
}

const state = api.run();
const actions = state.actions.filter((a) => a.kind !== "scroll" && a.kind !== "wait");
const labels = actions.map((a) => a.label || "");
const hasLabel = (t) => labels.some((l) => l === t);
const collapsed = labels.find((l) => l.includes("文章") && l.includes("贴图") && l.includes("视频"));

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log("  ok  - " + msg);
  else { console.error("  FAIL- " + msg); failures++; }
};

console.log(`Collected ${actions.length} actions:`);
for (const a of actions) console.log(`    ${a.kind}  ${a.label}`);

console.log("\nAssertions:");
assert(!collapsed, `menu wrapper NOT collapsed into one concat-label element${collapsed ? ` (got: "${collapsed.slice(0, 60)}…")` : ""}`);
assert(hasLabel("文章"), "menu item 文章 collected individually");
assert(hasLabel("选择已有内容"), "menu item 选择已有内容 collected individually");
assert(hasLabel("贴图"), "menu item 贴图 collected individually");
assert(hasLabel("视频"), "menu item 视频 collected individually");
assert(hasLabel("播客"), "menu item 播客 collected individually");
assert(hasLabel("普通操作"), "guard: single-leaf [onclick] control still collected");
assert(hasLabel("行标题 详情 编辑"), "guard: wrapper containing real links still collected");
assert(labels.some((l) => l.includes("详情")), "guard: link inside kept wrapper still collected");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
