// examples/demo_verify.mjs
// Show the M4 verification layer: given a page + a declarative spec, the tool
// decides (without any LLM) whether the flow reached the expected end state.
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
    return { x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10 };
  };
  w.innerWidth = 1280;
  w.innerHeight = 800;
  return w;
}

const win = makeWindow(
  `<!doctype html><html><head><title>Dashboard</title></head><body>
     <h1>欢迎,张三</h1>
     <input id="uname" aria-label="username" value="张三">
     <button aria-label="退出">退出</button>
   </body></html>`,
  "https://app.example.com/dashboard"
);
const script = win.document.createElement("script");
script.textContent = SNAPSHOT;
win.document.body.appendChild(script);

const spec = {
  verification: [
    { type: "url_matches", regex: "/dashboard" },
    { type: "text_contains", text: "欢迎" },
    { type: "element_present", name: "退出" },
    { type: "field_value", name: "username", equals: "张三" },
  ],
};

const result = win.__jevSnapshotExt.evaluateSpec(spec);
console.log("验证规范（design §4.3，纯声明式，无需大模型）：");
for (const c of spec.verification) console.log("  -", JSON.stringify(c));
console.log("\n对当前页面判定结果：", result.passed ? "✅ PASSED" : "❌ FAILED");
for (const c of result.checks) {
  console.log(`  [${c.ok ? "✓" : "✗"}] ${c.type}${c.detail ? "  (" + c.detail + ")" : ""}`);
}
console.log("\n说明：Jev 自己永不判定成功（needs_verification 只是交接）；");
console.log("最终通过必须由这份声明式规范 + 你的确认决定。");
