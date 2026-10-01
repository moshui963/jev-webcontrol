// Live M1 test: drive real Chrome, inject snapshot_extended.js into a real
// website, and show the penetration result (shadow DOM + same-origin iframe).
//
//   node examples/live_observe.mjs [URL]
//
// Default URL is the CSDN article the user pointed us at. CSDN is a great
// stress test: it's heavy with iframes (comments, ads) and some shadow DOM.

import { observeLive } from "../scripts/live_cdp.mjs";

const url =
  process.argv[2] || "https://blog.csdn.net/weixin_28829629/article/details/162137842";

console.log(`\n=== 真机观察 M1: ${url} ===\n`);

const state = await observeLive(url, { waitMs: 6000 });

console.log("页面 URL :", state.url);
console.log("标题     :", state.title);
const acts = state.actions || [];
console.log("候选操作 :", acts.length, "个\n");

// bucket by scope prefix for a quick penetration view
const byScope = new Map();
for (const a of acts) {
  const k = a.scope || "(主文档)";
  byScope.set(k, (byScope.get(k) || 0) + 1);
}
console.log("--- 作用域分布 (穿透情况) ---");
for (const [scope, n] of [...byScope.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${scope}`);
}
console.log();

console.log("--- 前 30 个候选 (id | 作用域 | 类型 | 标签 | 合成定位器) ---");
const sample = acts.filter((a) => a.kind !== "scroll" && a.kind !== "wait").slice(0, 30);
for (const a of sample) {
  const loc = a.locator
    ? a.locator.strategies
        .map((s) => `${s.type}=${s.role || s.selector || s.name || ""}`)
        .join(" | ")
    : "-";
  console.log(
    `  ${String(a.id).padEnd(4)} | ${(a.scope || "(主文档)").padEnd(28)} | ${(a.kind || "").padEnd(6)} | ${String(a.label).slice(0, 22).padEnd(22)} | ${loc}`
  );
}
console.log(
  "\n(跨源 iframe 内的元素按设计被安全跳过 — 不泄漏、不报错)"
);
