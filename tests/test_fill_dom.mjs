// tests/test_fill_dom.mjs — 输入框 DOM 行为回归（v0.4.24）
// 修复点：
//  (1) contenteditable（富文本/评论框/类 Notion 编辑器）没有 .value 属性，
//      旧代码 el.value=val 只挂了个无用展开属性，框里啥也没写；现改为写 textContent，
//      且 input_value 校验范围扩到 contenteditable。
//  (2) 输入框 label 优先用关联 <label> 文本（用户名 / 密码），让 jev 更易区分。
// Run: node tests/test_fill_dom.mjs
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.resolve(__dirname, "../extension/content/snapshot_injected.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

// 在独立 jsdom 窗口里加载注入脚本，拿到 window.__jevSnapshotExt
// 注：run() 依赖 getBoundingClientRect / checkVisibility 判定尺寸与可见性，
// jsdom 不布局（全 0 尺寸），故按 test_snapshot.mjs 的方式打桩，否则收集不到候选。
function load(html) {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.checkVisibility = function () { return true; };
  w.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 };
  };
  w.document.createRange().constructor.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
  };
  w.eval(code);
  return w.__jevSnapshotExt;
}

// ---- (1) input_value 现在能识别 contenteditable 里的内容 ----
{
  const ext = load(`<!DOCTYPE html><html><body>
    <div id="ce" contenteditable="true">hello world</div>
  </body></html>`);
  const res = ext.evaluateSpec({ verification: [{ type: "input_value", text: "hello" }] });
  ok("input_value 命中 contenteditable 文本", res && res.passed === true);
}

// ---- (1b) 普通 input 仍正常 ----
{
  const ext = load(`<!DOCTYPE html><html><body>
    <input id="u" value="投影灯" />
  </body></html>`);
  const res = ext.evaluateSpec({ verification: [{ type: "input_value", text: "投影灯" }] });
  ok("input_value 命中普通 input", res && res.passed === true);
  const miss = ext.evaluateSpec({ verification: [{ type: "input_value", text: "不存在" }] });
  ok("input_value 未命中时判定失败", miss && miss.passed === false);
}

// ---- (1c) 反例：纯文本不在任何字段里 → 不算填入 ----
{
  const ext = load(`<!DOCTYPE html><html><body>
    <p>页面里随便一段包含投影灯的文字</p>
    <input id="u" value="" />
  </body></html>`);
  const res = ext.evaluateSpec({ verification: [{ type: "input_value", text: "投影灯" }] });
  ok("正文含关键词但字段为空 → 判定未填入", res && res.passed === false);
}

// ---- (2) 输入框 label 优先用关联 <label> 文本 ----
{
  const ext = load(`<!DOCTYPE html><html><body>
    <label for="user">用户名</label><input id="user" value="" />
    <label for="pw">密码</label><input id="pw" type="password" value="" />
    <input id="q" placeholder="搜索关键词" value="" />
  </body></html>`);
  const snap = ext.run();
  const labels = (snap.actions || []).map((a) => a.label);
  ok("用户名输入框 label 取自关联 label", labels.includes("用户名"));
  ok("搜索框 label 取自 placeholder", labels.includes("搜索关键词"));
  ok("密码输入框未误用关联 label 被剔除收集（password 不进入快照）", !labels.includes("密码"));
  // 关联 label 优先级高于 placeholder：若同时有 label 和 placeholder，应取 label
  const ext2 = load(`<!DOCTYPE html><html><body>
    <label for="x">昵称</label><input id="x" placeholder="请输入" value="" />
  </body></html>`);
  const labels2 = (ext2.run().actions || []).map((a) => a.label);
  ok("关联 label 优先于 placeholder（昵称 > 请输入）", labels2.includes("昵称"));
}

console.log(`\n${fail ? "✗" : "✓"} test_fill_dom: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
