/*
 * Regression test (v0.4.20): DOM probe clicked an OCCLUDED element.
 *
 * Symptom (h3yun 导出对话框): with the export dialog open, the probe still
 * reported a "click" hit on the toolbar 导出 button (381,86) — CSS-visible but
 * UNDER the modal overlay. The CDP click landed on the overlay, nothing
 * happened, and stuck-detection escalated after 3 identical steps.
 *
 * Fix: probeInPage now hit-tests each candidate at its own center
 * (document.elementFromPoint); an element that is not the topmost element
 * there is marked occluded and excluded from BOTH the click and expand
 * buckets in interpretProbe.
 *
 * Run: node tests/test_probe_occlusion.mjs   (needs jsdom)
 */
import { JSDOM } from "jsdom";
import { PROBE_FN, interpretProbe } from "../extension/lib/probe.js";

// Layout (fits jsdom's 1024x768 viewport):
//   toolbar 导出 button  rect (350,76,60,20)  center (380,86)  <- covered by overlay
//   modal overlay        rect (0,0,1024,768)  on top of everything
//   dialog 导出 button   rect (892,730,60,26) center (922,743) <- topmost
const html = `<!doctype html><html><head></head><body>
  <button id="toolbar-export">导出</button>
  <div id="overlay">
    <div id="dialog">
      <button id="dialog-export"><span id="dialog-export-span">导出</span></button>
      <!-- v0.4.21: styled-div confirm button (this ERP's real pattern) -->
      <div id="div-export" style="cursor:pointer">导出</div>
    </div>
  </div>
</body></html>`;

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://erp.example.com/" });
const { window } = dom;
const { document } = window;

const RECTS = {
  "toolbar-export": { left: 350, top: 76, width: 60, height: 20 },
  overlay: { left: 0, top: 0, width: 1024, height: 768 },
  "dialog-export": { left: 892, top: 730, width: 60, height: 26 },
  "div-export": { left: 500, top: 400, width: 80, height: 30 },
};
for (const [id, r] of Object.entries(RECTS)) {
  const el = document.getElementById(id);
  el.getBoundingClientRect = () => ({
    left: r.left, top: r.top, width: r.width, height: r.height,
    right: r.left + r.width, bottom: r.top + r.height,
    x: r.left, y: r.top,
  });
}
const inRect = (x, y, r) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
const pointIn = (x, y, id) => {
  const r = RECTS[id];
  return inRect(x, y, r) ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
};
// Simulated stacking: overlay on top; the dialog button (and its span) above
// the overlay background; everything else below the overlay.
let overrideTop = null; // test hook: force elementFromPoint result
document.elementFromPoint = (x, y) => {
  if (overrideTop) return overrideTop;
  if (pointIn(x, y, "dialog-export")) return document.getElementById("dialog-export-span");
  if (pointIn(x, y, "div-export")) return document.getElementById("div-export");
  if (pointIn(x, y, "overlay")) return document.getElementById("overlay");
  return document.body;
};

const data = JSON.parse(window.eval(PROBE_FN + "(" + JSON.stringify("导出") + ")"));
const hitById = (id) => {
  const el = document.getElementById(id);
  const r = RECTS[id];
  return data.hits.find((h) => h.rect && h.rect.x === Math.round(r.left + r.width / 2) && h.rect.y === Math.round(r.top + r.height / 2) && (el.contains(document.body) || true));
};

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

// Both buttons match the text, so we get two hits — identify them by coords.
const toolbarHit = data.hits.find((h) => h.rect.x === 380);
const dialogHit = data.hits.find((h) => h.rect.x === 922);
ok("probe finds both 导出 buttons", !!toolbarHit && !!dialogHit);
ok("toolbar 导出: CSS-visible but marked occluded", toolbarHit && toolbarHit.visible === true && toolbarHit.occluded === true);
ok("dialog 导出: topmost at own center -> not occluded", dialogHit && dialogHit.visible === true && dialogHit.occluded === false);

// interpretProbe must pick the DIALOG button, never the covered toolbar one.
const interp = interpretProbe(data, "导出");
ok("interpretProbe mode=click", interp.mode === "click");
ok("click targets the dialog button center (922,743), not the covered toolbar (380,86)",
   interp.mode === "click" && interp.x === 922 && interp.y === 743);

// All hits occluded -> mode none (never click through an overlay).
const allOccluded = { hits: data.hits.map((h) => ({ ...h, occluded: true })) };
ok("all hits occluded -> mode none (no blind clicking)",
   interpretProbe(allOccluded, "导出").mode === "none");

// Regression guard: without overlay coverage the toolbar button is clickable.
overrideTop = document.getElementById("toolbar-export");
const data2 = JSON.parse(window.eval(PROBE_FN + "(" + JSON.stringify("导出") + ")"));
const toolbar2 = data2.hits.find((h) => h.rect.x === 380);
ok("no overlay -> toolbar 导出 stays clickable (occluded=false)", toolbar2 && toolbar2.occluded === false);

// v0.4.21: a styled-div confirm button (cursor:pointer, NO a/button/role/
// onclick/tabindex cue) must be collected by the probe — this ERP's dialog
// confirm button is exactly such a div, and missing it made the probe click
// the inert containment match 导出数据 (dialog title) instead.
overrideTop = null; // restore simulated stacking for the div's own center
const data3 = JSON.parse(window.eval(PROBE_FN + "(" + JSON.stringify("导出") + ")"));
const divHit = data3.hits.find((h) => h.rect.x === 540 && h.rect.y === 415);
ok("cursor:pointer styled-div 导出 IS collected by probe", !!divHit);
ok("styled-div 导出 is topmost at own center (occluded=false)", divHit && divHit.occluded === false);

// v0.4.21: interpretProbe returns a score so the Controller can demand a
// STRONG match before letting the probe take the click from a live jev
// decision. 导出 vs 导出数据 must be 0.75 (weak), exact 导出 must be 1.
const weak = interpretProbe({ hits: [{ visible: true, occluded: false, inViewport: true, rect: { x: 1, y: 1, w: 10, h: 10 }, text: "导出数据" }] }, "导出");
ok("containment match 导出->导出数据 scores 0.75 (below the 0.8 takeover bar)",
   weak.mode === "click" && Math.abs(weak.score - 0.75) < 1e-9);
const exact = interpretProbe({ hits: [{ visible: true, occluded: false, inViewport: true, rect: { x: 1, y: 1, w: 10, h: 10 }, text: "导出" }] }, "导出");
ok("exact match 导出->导出 scores 1.0", exact.mode === "click" && exact.score === 1);

console.log(`\n${fail ? "✗" : "✓"} test_probe_occlusion: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
