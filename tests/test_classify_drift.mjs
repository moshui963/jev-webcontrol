// 架构守卫（v0.4.25）：元素分类器必须是单一事实来源。收集器（snapshot_injected.js）
// 与 lib 代码都引用同一份 classifyElement 源码；若有人手改了其中一份，本测试失败
// —— 防止 v0.4.22 那种「两套引擎对「什么是可点击」判断漂移」的复发。
import { CLASSIFY_SRC } from "../extension/lib/element-taxonomy.js";
import fs from "fs";

const SNAP = fs.readFileSync(
  new URL("../extension/content/snapshot_injected.js", import.meta.url)
);

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };
// 归一化：去注释 + 去空白，只比对「功能等价」而非逐字。这样规范源码里加 // 说明注释
// 不会导致漂移测试误报；真正漂移（改了分类逻辑）仍会被抓到。
const norm = (s) => (s || "")
  .replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释
  .replace(/\/\/[^\n]*/g, "")          // 行注释
  .replace(/\s+/g, "");

const m = SNAP.toString().match(/\/\*CLASSIFY_START\*\/([\s\S]*?)\/\*CLASSIFY_END\*\//);
ok("snapshot collector 在 CLASSIFY_START/END 之间内嵌了 classifyElement", !!m);
ok("snapshot 内嵌分类器 == 规范源码（无漂移）", m && norm(m[1]) === norm(CLASSIFY_SRC));

console.log(`\n${fail ? "✗" : "✓"} test_classify_drift: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
