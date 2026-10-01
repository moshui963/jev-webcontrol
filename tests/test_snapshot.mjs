/*
 * M1 test: verify snapshot_extended.js penetrates open shadow DOM and same-origin
 * iframes, tags each action with a `scope` path, and safely skips cross-origin iframes.
 *
 * Run: npm run test:snapshot   (needs jsdom: npm install)
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = readFileSync(join(__dirname, "..", "scripts", "snapshot_extended.js"), "utf8");

// Deterministic same-origin child document (jsdom does not load srcdoc synchronously).
const childDom = new JSDOM(`<!doctype html><body><button id="frame-btn">Iframe Button</button></body>`, {
  url: "https://app.example.com/frame",
});
const childDoc = childDom.window.document;
// The child document lives in a separate jsdom window; its elements use the child window's
// prototypes, so geometry/visibility stubs must be applied there too (real browsers share one window).
childDom.window.Element.prototype.checkVisibility = function () { return true; };
childDom.window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 };
};

const html = `<!doctype html><html><head></head><body>
  <button id="main-btn">Main Button</button>
  <div id="shadow-host"></div>
  <iframe id="same-iframe"></iframe>
  <iframe id="xorigin-iframe" src="https://other.example.com/page"></iframe>
</body></html>`;

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://app.example.com/" });
const { window } = dom;

// --- geometry / visibility stubs so run() can produce actions under jsdom ---
window.Element.prototype.checkVisibility = function () { return true; };
window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 };
};
// jsdom's Range lacks getBoundingClientRect; patch the real prototype (used in collectText).
window.document.createRange().constructor.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
};

// Build the shadow DOM (jsdom supports open shadow roots).
const host = window.document.getElementById("shadow-host");
const sr = host.attachShadow({ mode: "open" });
const shadowBtn = window.document.createElement("button");
shadowBtn.id = "shadow-btn";
shadowBtn.textContent = "Shadow Button";
sr.appendChild(shadowBtn);

// Same-origin iframe: hand it a real (deterministic) contentDocument.
const sameFrame = window.document.getElementById("same-iframe");
Object.defineProperty(sameFrame, "contentDocument", { configurable: true, value: childDoc });

// Cross-origin iframe: contentDocument access must throw -> safely skipped.
const xframe = window.document.getElementById("xorigin-iframe");
Object.defineProperty(xframe, "contentDocument", {
  configurable: true,
  get() { throw new Error("cross-origin frame"); },
});

// Inject the snapshot script into the window context.
const script = window.document.createElement("script");
script.textContent = SNAPSHOT;
window.document.body.appendChild(script);

const api = window.__jevSnapshotExt;
if (!api || typeof api.run !== "function") {
  console.error("FAIL: snapshot_extended.js did not expose window.__jevSnapshotExt.run");
  process.exit(1);
}

const state = api.run();
const actions = state.actions;
const byScope = (s) => actions.filter((a) => a.scope === s);
const hasLabel = (list, sub) => list.some((a) => (a.label || "").includes(sub));
const scopeOf = (a) => (a.scope === "" ? "(root)" : a.scope);

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log("  ok  - " + msg);
  else { console.error("  FAIL- " + msg); failures++; }
};

console.log(`Collected ${actions.length} candidate actions (scope-tagged):`);
for (const a of actions) console.log(`    [${scopeOf(a)}] ${a.kind}  ${a.label}`);

console.log("\nAssertions:");
// 1) main document button found with empty scope
assert(byScope("").length > 0, "main document scope '' exists");
assert(hasLabel(byScope(""), "Main Button"), "main button collected under scope ''");

// 2) shadow DOM button found with a ::shadow/ scope
const shadowActions = actions.filter((a) => a.scope && a.scope.includes("::shadow/"));
assert(shadowActions.length > 0, "at least one action inside an open shadow root");
assert(hasLabel(shadowActions, "Shadow Button"), "shadow button collected with ::shadow/ scope");

// 3) same-origin iframe button found with iframe[0]/ scope
assert(byScope("iframe[0]/").length > 0, "same-origin iframe scope 'iframe[0]/' exists");
assert(hasLabel(byScope("iframe[0]/"), "Iframe Button"), "same-origin iframe button collected");

// 4) cross-origin iframe safely skipped (no iframe[1]/ produced)
assert(byScope("iframe[1]/").length === 0, "cross-origin iframe skipped (no iframe[1]/ scope)");
const crossLeak = actions.filter((a) => a.label.includes("xorigin") || a.label.includes("other.example"));
assert(crossLeak.length === 0, "no element leaked from the cross-origin frame");

// 5) state shape preserved (jev-compatible fields present)
for (const key of ["url", "title", "text", "actions", "marker", "page_key", "guards"]) {
  assert(key in state, `state has '${key}' (jev-compatible shape)`);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
