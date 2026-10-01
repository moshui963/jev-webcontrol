// Architecture guard (v0.4.22): the "what is clickable" predicate MUST be a
// SINGLE source of truth. The snapshot collector (content/snapshot_injected.js)
// and the DOM probe (lib/probe.js) both embed the SAME isButtonLike source. If
// anyone hand-edits one copy, this test fails — preventing the drift that caused
// "probe missed the styled-div button / clicked the inert dialog title".
import { IS_BUTTON_SRC, isButtonLikeSrc } from "../extension/lib/dom-cues.js";
import { PROBE_FN } from "../extension/lib/probe.js";
import fs from "fs";

const SNAP = fs.readFileSync(
  new URL("../extension/content/snapshot_injected.js", import.meta.url)
);

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };
const norm = (s) => (s || "").replace(/\s+/g, "");

// 1) The snapshot collector embeds a copy wrapped in /*DOM_CUES_START*/…/*DOM_CUES_END*/.
const m = SNAP.toString().match(/\/\*DOM_CUES_START\*\/([\s\S]*?)\/\*DOM_CUES_END\*\//);
ok("snapshot collector embeds isButtonLike between DOM_CUES markers", !!m);
ok("snapshot's embedded clickable predicate == canonical source (no drift)", m && norm(m[1]) === norm(IS_BUTTON_SRC));

// 2) The probe injects the canonical source at build time.
ok("probe PROBE_FN embeds the canonical isButtonLike source", PROBE_FN.includes(IS_BUTTON_SRC));

// 3) Behaviour: the single predicate recognises every clickable cue.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM(`<!doctype html><body>
  <a id="lnk" href="#">link</a>
  <button id="btn">btn</button>
  <div id="cdiv" style="cursor:pointer">styled button</div>
  <div id="plain">plain</div>
  <div id="tab" tabindex="0">focusable</div>
  <span id="clk" onclick="1"> onclick span</span>
  <div id="cls" class="ant-btn">class btn</div>
</body>`, { runScripts: "dangerously", pretendToBeVisual: true });
const { document } = dom.window;
// jsdom's getComputedStyle has no cursor support; reflect inline style so the
// cursor:pointer cue is exercised (in a real browser getComputedStyle works).
globalThis.getComputedStyle = (el) => ({ cursor: (el.style && el.style.cursor) || "" });
const is = (id) => isButtonLikeSrc(document.getElementById(id));
ok("<a> is clickable", is("lnk") === true);
ok("<button> is clickable", is("btn") === true);
ok("cursor:pointer styled div IS clickable (the ERP dialog-button case)", is("cdiv") === true);
ok("plain div is NOT clickable", is("plain") === false);
ok("tabindex=0 is clickable", is("tab") === true);
ok("onclick span is clickable", is("clk") === true);
ok("ant-btn class div is clickable", is("cls") === true);

console.log(`\n${fail ? "✗" : "✓"} test_dom_cues: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
