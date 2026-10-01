/*
 * Resolver regression test (v0.4.15 refactor): the per-scope resolver in
 * snapshot_injected.js collapses the old ad-hoc passes (menu pruning ×2, nested
 * same-label dedup, occlusion) into ONE pipeline:
 *   expandMenus -> keepInnermost(residual) -> occlusion.
 * This test locks the three behaviours the refactor must preserve.
 *
 * Run: node tests/test_resolver.mjs   (needs jsdom)
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = readFileSync(join(__dirname, "..", "extension", "content", "snapshot_injected.js"), "utf8");

// h3yun-style nested same-label: outer .pointer div wraps a real [role=tab].
// Both must be collected, then the resolver keeps the INNER tab, drops wrapper.
// Also a card that holds its own button (outer must stay, residual non-empty).
// Also a menu wrapper (>=3 leaves) must expand into items.
const html = `<!doctype html><html><head></head><body>
  <button id="main-btn">Main Button</button>

  <div id="tabwrap" class="pointer"><span role="tab" class="pointer">导出数据</span></div>

  <div id="card" class="pointer"><span class="pointer">项目A</span><button id="del">删除</button></div>

  <div id="menu" class="pointer" onclick="">
    <div class="item pointer"><img><span>文章</span></div>
    <div class="item pointer"><img><span>选择已有内容</span></div>
    <div class="item pointer"><img><span>贴图</span></div>
  </div>
</body></html>`;

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://app.example.com/" });
const { window } = dom;
window.Element.prototype.checkVisibility = function () { return true; };
window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 };
};
window.document.createRange().constructor.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "innerText", {
  get() { return this.textContent; },
  configurable: true,
});
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
const hasSubstr = (t) => labels.some((l) => l.includes(t));

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log("  ok  - " + msg);
  else { console.error("  FAIL- " + msg); failures++; }
};

console.log(`Collected ${actions.length} actions:`);
for (const a of actions) console.log(`    ${a.kind}  ${a.label}`);

console.log("\nAssertions:");
// 1) nested same-label: wrapper dropped, inner [role=tab] kept
assert(hasLabel("导出数据"), "inner [role=tab] 导出数据 kept (wrapper dropped)");
assert(!labels.some((l) => l.length > 12 && l.includes("导出数据")), "no concat-wrapper duplicate for 导出数据");

// 2) card + its own button: BOTH kept (residual non-empty). The card's label
//    includes the button text ("项目A 删除") because name() reads children; the
//    card click target must still be present, exactly once.
assert(hasSubstr("项目A"), "card 项目A kept (has own purpose)");
assert(hasLabel("删除"), "card's button 删除 kept");
const cardCount = labels.filter((l) => l.includes("项目A")).length;
assert(cardCount === 1, "card appears once (inner span not duplicated into its own target)");

// 3) menu wrapper expands into items, container gone (no concat label with all items)
const collapsedMenu = labels.find((l) => l.includes("文章") && l.includes("贴图") && l.includes("选择已有内容"));
assert(!collapsedMenu, "menu wrapper NOT collapsed into one concat-label element");
assert(hasLabel("文章") && hasLabel("选择已有内容") && hasLabel("贴图"), "menu items 文章/选择已有内容/贴图 collected individually");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
