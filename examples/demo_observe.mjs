// examples/demo_observe.mjs
// 不依赖 Chrome，用 jsdom 模拟一个"企业后台"页面，演示感知层把网页
// 变成"带作用域的元素清单"这一核心能力（这正是后续选元素/合成定位器的原料）。
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SNAPSHOT = readFileSync(
  new URL("../scripts/snapshot_extended.js", import.meta.url),
  "utf8"
);

// 给 jsdom 补上真实浏览器才有、但 jsdom 缺失的几何/可见性 API。
function makeWindow(html, url) {
  const dom = new JSDOM(html, { runScripts: "dangerously", url });
  const w = dom.window;
  w.Element.prototype.checkVisibility = function () {
    return true;
  };
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

const mainWin = makeWindow(
  `<!doctype html><html><head><title>Acme 控制台</title></head><body>
    <h1>Acme 控制台</h1>
    <button id="export">导出报表</button>
    <a href="/settings">系统设置</a>
    <div id="shadow-host"></div>
    <iframe id="report"></iframe>
    <iframe id="ads" src="https://ads.example.com"></iframe>
  </body></html>`,
  "https://acme.example.com/"
);
const mainDoc = mainWin.document;

// 模拟 Salesforce Lightning 风格组件：把按钮藏在 open shadow root 里
const host = mainDoc.getElementById("shadow-host");
host.attachShadow({ mode: "open" }).innerHTML =
  `<button id="lightning-save">保存(Lightning 组件)</button>`;

// 同源 iframe（报表区）：真实环境由 harness 自动枚举，这里手动挂上子文档
const childWin = makeWindow(
  `<!doctype html><body><button id="refresh">刷新报表</button></body>`,
  "https://acme.example.com/report"
);
Object.defineProperty(mainDoc.getElementById("report"), "contentDocument", {
  value: childWin.document,
  configurable: true,
});

// 注入快照脚本（真实环境是 harness 通过 CDP 注入到每个 frame）
const script = mainDoc.createElement("script");
script.textContent = SNAPSHOT;
mainDoc.body.appendChild(script);

const state = mainWin.__jevSnapshotExt.run();

// ---- 输出一张人类可读的元素清单（含 M2 合成的 durable locator）----
const scopeLabel = (s) => (s ? s : "(主文档)");
const locLabel = (a) => {
  const s = a.locator && a.locator.strategies && a.locator.strategies[0];
  if (!s) return "";
  return s.type === "semantic" ? `语义[${s.role}=${s.name}]` : `${s.type}:${s.selector}`;
};
console.log("页面:", state.url, "| 标题:", state.title);
console.log("被看到的候选操作（已穿透 shadow + 同源 iframe，跨源 iframe 已安全跳过）：\n");
console.log("  ID  | 作用域                    | 类型    | 标签                     | M2 合成的定位器(主策略)");
console.log("  " + "-".repeat(86));
for (const a of state.actions) {
  if (a.kind === "scroll" || a.kind === "wait") continue;
  console.log(
    `  ${a.id.padEnd(4)} | ${scopeLabel(a.scope).padEnd(24)} | ${(a.kind || "").padEnd(6)} | ${a.label.padEnd(22)} | ${locLabel(a)}`
  );
}
console.log("\n（跨源 iframe #ads 没有出现在上面 —— 它没有泄漏任何元素，符合安全预期）");
console.log("注意 M2 的定位器是「多策略」的：优先稳定属性(#id/data-testid)，最后兜底到");
console.log("「角色+可读名」语义身份——这样页面改版(换结构/删 id)时仍能找回同一个元素。");
