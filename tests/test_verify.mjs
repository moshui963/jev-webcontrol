// tests/test_verify.mjs
// M4 verification — no Chrome needed. Proves the live evaluateSpec() against the
// DOM, plus writes fixtures so the Python offline path (verify.py) can be checked.
import { JSDOM } from "jsdom";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  // Non-zero so collectText() gathers page text (for the offline path).
  const rp = w.document.createRange().constructor.prototype;
  rp.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10 };
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

const spec = {
  verification: [
    { type: "url_matches", regex: "/dashboard" },
    { type: "text_contains", text: "欢迎" },
    { type: "element_present", name: "退出" },
    { type: "field_value", name: "username", equals: "张三" },
  ],
};

console.log("\n[M4] live evaluateSpec()");

// --- success page: everything matches ---
const okWin = makeWindow(
  `<!doctype html><html><head><title>Dashboard</title></head><body>
     <h1>欢迎,张三</h1>
     <input id="uname" aria-label="username" value="张三">
     <button aria-label="退出">退出</button>
   </body></html>`,
  "https://app.example.com/dashboard"
);
const okScript = okWin.document.createElement("script");
okScript.textContent = SNAPSHOT;
okWin.document.body.appendChild(okScript);
const okResult = okWin.__jevSnapshotExt.evaluateSpec(spec);
assert(okResult.passed === true, "success page passes all 4 checks");

// --- failure page: on the login screen, nothing matches ---
const badWin = makeWindow(
  `<!doctype html><html><head><title>Login</title></head><body>
     <h1>请登录</h1>
     <input id="uname" aria-label="username" value="">
     <button aria-label="登录">登录</button>
   </body></html>`,
  "https://app.example.com/login"
);
const badScript = badWin.document.createElement("script");
badScript.textContent = SNAPSHOT;
badWin.document.body.appendChild(badScript);
const badResult = badWin.__jevSnapshotExt.evaluateSpec(spec);
assert(badResult.passed === false, "login page fails verification");
const failedTypes = badResult.checks.filter((c) => !c.ok).map((c) => c.type);
assert(
  failedTypes.includes("url_matches") && failedTypes.includes("element_present"),
  "failure is reported per-check (url_matches + element_present failed)"
);
assert(
  badResult.checks.find((c) => c.type === "field_value").detail.length > 0,
  "failed checks carry a human-readable reason"
);

// --- unknown check type is safe, not throwing ---
const weird = okWin.__jevSnapshotExt.evaluateSpec({ verification: [{ type: "bogus" }] });
assert(weird.passed === false && weird.checks[0].detail === "unknown check type", "unknown check type handled safely");

// --- write fixtures for the Python offline path ---
mkdirSync(new URL("../tests/fixtures/", import.meta.url), { recursive: true });
const successState = okWin.__jevSnapshotExt.run();
writeFileSync(new URL("../tests/fixtures/spec.json", import.meta.url), JSON.stringify(spec, null, 2));
writeFileSync(new URL("../tests/fixtures/success_state.json", import.meta.url), JSON.stringify(successState, null, 2));

console.log(`\n[M4] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
