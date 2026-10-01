// tests/test_locator.mjs
// M2 verification (no Chrome needed): the durable locator can re-find its
// element across DOM churn, falling back from brittle CSS to semantic identity.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SNAPSHOT = readFileSync(
  new URL("../scripts/snapshot_extended.js", import.meta.url),
  "utf8"
);

function makeWindow(html, url) {
  const dom = new JSDOM(html, { runScripts: "dangerously", url });
  const w = dom.window;
  w.Element.prototype.checkVisibility = function () { return true; };
  w.Element.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 10, width: 120, height: 30, top: 10, bottom: 40, left: 10, right: 130 };
  };
  const rp = w.document.createRange().constructor.prototype;
  rp.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
  };
  w.innerWidth = 1280;
  w.innerHeight = 800;
  return w;
}

let passed = 0, failed = 0;
const assert = (cond, msg) => {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.log("  ✗ " + msg); }
};

// --- setup: a page with a normal button + a shadow-DOM button ---
const mainWin = makeWindow(
  `<!doctype html><html><head><title>Acme</title></head><body>
    <button id="export">导出报表</button>
    <div id="shadow-host"></div>
  </body></html>`,
  "https://acme.example.com/"
);
const mainDoc = mainWin.document;
const host = mainDoc.getElementById("shadow-host");
const sr = host.attachShadow({ mode: "open" });
sr.innerHTML = `<button id="lightning-save">保存(Lightning 组件)</button>`;
const shadowBtn = sr.querySelector("#lightning-save");

const script = mainDoc.createElement("script");
script.textContent = SNAPSHOT;
mainDoc.body.appendChild(script);
const api = mainWin.__jevSnapshotExt;

console.log("\n[M2] locator synthesis + resolve");

// 1) every candidate action now carries a locator
const state = api.run();
const exportAct = state.actions.find((a) => a.label === "导出报表");
const shadowAct = state.actions.find((a) => a.label === "保存(Lightning 组件)");
assert(!!exportAct && !!exportAct.locator, "normal button carries a locator");
assert(!!shadowAct && !!shadowAct.locator, "shadow button carries a locator");

// 2) the shadow locator records its scope
assert(
  shadowAct.locator.scope.includes("::shadow"),
  "shadow locator scope records ::shadow (" + shadowAct.locator.scope + ")"
);

// 3) resolve finds the EXACT same node (reference equality) via the locator
const foundShadow = api.resolve(mainDoc, shadowAct.locator);
assert(foundShadow === shadowBtn, "resolve(locator) returns the identical shadow node");
const foundExport = api.resolve(mainDoc, exportAct.locator);
assert(foundExport === mainDoc.getElementById("export"), "resolve(locator) returns the identical normal node");

// 4) semantic strategy is present (survives DOM churn)
const hasSemantic = shadowAct.locator.strategies.some((s) => s.type === "semantic");
assert(hasSemantic, "locator has a semantic (role+name) strategy");

// 5) CHURN: wrap host in a div + strip the shadow button's id.
//    The brittle CSS `#lightning-save` strategy must now fail, but semantic
//    identity must still re-find the same node.
const wrapper = mainDoc.createElement("div");
host.parentNode.insertBefore(wrapper, host);
wrapper.appendChild(host);
shadowBtn.removeAttribute("id");

const stillFound = api.resolve(mainDoc, shadowAct.locator);
assert(
  stillFound === shadowBtn,
  "after churn (wrapped + id removed) locator still re-finds the SAME node via fallback"
);

// 6) a locator for a non-existent element resolves to null
const missing = api.resolve(mainDoc, {
  scope: "",
  strategies: [{ type: "css", selector: "#does-not-exist" }],
});
assert(missing === null, "non-existent locator resolves to null (safe, no throw)");

console.log(`\n[M2] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
