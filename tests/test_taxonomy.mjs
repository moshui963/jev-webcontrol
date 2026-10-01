// v0.4.25 — 元素/动作分类注册表 + 统一执行入口的单测。
import { JSDOM } from "jsdom";
import { classifyElement, ACTION_VERBS, VERB_CATEGORY, CLASSIFY_SRC } from "../extension/lib/element-taxonomy.js";
import { normalizeDate, findDateCell, buildKeyEvents, dispatchAction, coverageOk, knownVerbs } from "../extension/lib/actions/registry.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b));

const dom = new JSDOM(`<!doctype html><body></body>`, { runScripts: "outside-only" });
const doc = dom.window.document;
const mk = (html) => { doc.body.innerHTML = html; return doc.body.firstElementChild; };

console.log("— 元素分类 classifyElement —");
eq("input[text] → 文本类/fill", classifyElement(mk(`<input type="text">`)), { category: "text", label: "text", kind: "fill", conf: 0.9 });
eq("textarea → 文本类/fill", classifyElement(mk(`<textarea></textarea>`)), { category: "text", label: "text", kind: "fill", conf: 0.95 });
{
  const el = mk(`<div contenteditable="true"></div>`);
  Object.defineProperty(el, "isContentEditable", { value: true });
  eq("contenteditable → 文本类/fill", classifyElement(el).kind, "fill");
}
eq("button → 激活类/click", classifyElement(mk(`<button>go</button>`)).kind, "click");
eq("a → 激活类/click", classifyElement(mk(`<a href="#">x</a>`)).kind, "click");
eq("select → 选择类/select", classifyElement(mk(`<select><option>1</option></select>`)).kind, "select");
eq("input[checkbox] → 选择类", classifyElement(mk(`<input type="checkbox">`)).category, "selection");
eq("input[date] → 调节类/setDate", classifyElement(mk(`<input type="date">`)), { category: "adjust", label: "adjust", kind: "setDate", conf: 0.95 });
eq("input[datetime-local] → setDate", classifyElement(mk(`<input type="datetime-local">`)).kind, "setDate");
ok("input[range] → 调节类/setRange", (() => { const r = mk(`<input>`); r.type = "range"; return classifyElement(r).kind === "setRange"; })());
eq("input[file] → 文件类/upload", classifyElement(mk(`<input type="file">`)).kind, "upload");
eq("progress → 状态类/read", classifyElement(mk(`<progress></progress>`)).kind, "read");
{
  const el = mk(`<div draggable="true"></div>`);
  eq("draggable div → 拖拽类/drag", classifyElement(el).kind, "drag");
}
ok("普通 div 不归类（返回 null）", classifyElement(mk(`<div>plain</div>`)) === null);
ok("VERB_CATEGORY 覆盖全部动词", ACTION_VERBS.every((v) => VERB_CATEGORY[v]));

console.log("— 纯函数 —");
eq("normalizeDate ISO", normalizeDate("2026-09-01"), { y: 2026, m: 9, d: 1 });
eq("normalizeDate 斜杠", normalizeDate("2026/9/1"), { y: 2026, m: 9, d: 1 });
eq("normalizeDate 中文", normalizeDate("2026年9月1日"), { y: 2026, m: 9, d: 1 });
eq("normalizeDate m/d/y", normalizeDate("9/1/2026"), { y: 2026, m: 9, d: 1 });
ok("normalizeDate 非法 → null", normalizeDate("hello") === null);
{
  // 日历：包含 15 号可用格 + 一个 disabled 的 15（不该命中）。用合法 <table> 结构，
  // 否则 jsdom 会把游离 <td> 丢弃。
  doc.body.innerHTML = `<table class="cal"><tr><td>14</td><td class="disabled">15</td><td>15</td><td class="outside">15</td></tr></table>`;
  const root = doc.querySelector(".cal");
  const cell = findDateCell(root, { y: 2026, m: 9, d: 15 });
  ok("findDateCell 命中可用 15 号格（跳过 disabled/outside）", cell && cell.textContent.trim() === "15" && !/disabled|outside/.test(cell.className));
}
{
  const evs = buildKeyEvents("AB");
  ok("buildKeyEvents 每个字符生成 keyDown+keyUp", evs.length === 4 && evs.every((e) => e.type === "keyDown" || e.type === "keyUp"));
}

console.log("— 统一执行入口 dispatchAction —");
ok("coverageOk：注册表覆盖全部动词", coverageOk());
ok("knownVerbs 含 setDate 等新增动词", knownVerbs().includes("setDate") && knownVerbs().includes("drag") && knownVerbs().includes("hover"));

{
  const calls = [];
  const deps = {
    point: async () => ({ ok: true, cx: 10, cy: 10, label: "x" }),
    cdpClick: async () => { calls.push("cdpClick"); },
    cdpHover: async () => { calls.push("cdpHover"); },
    cdpDrag: async () => { calls.push("cdpDrag"); },
    cdpType: async () => { calls.push("cdpType"); },
    actInject: async () => { calls.push("actInject"); return { ok: true }; },
    readField: async () => "",
    isNativeDate: async () => false,
    setDateNative: async () => ({ ok: true }),
    openDatePicker: async () => { calls.push("openDatePicker"); return { ok: true }; },
    resolveDateCell: async () => ({ cx: 5, cy: 5 }),
    clickDateNav: async () => ({ ok: true }),
    sleep: async () => {},
  };
  const r1 = await dispatchAction({ kind: "click" }, deps);
  ok("click → 走 CDP", r1.ok && r1.via === "cdp" && calls.includes("cdpClick"));
  calls.length = 0;
  const r2 = await dispatchAction({ kind: "hover" }, deps);
  ok("hover → 走 CDP", r2.ok && calls.includes("cdpHover"));
  calls.length = 0;
  const r3 = await dispatchAction({ kind: "drag", locator: { name: "src" }, dx: 5, dy: 5 }, deps);
  ok("drag → 走 CDP", r3.ok && calls.includes("cdpDrag"));
  calls.length = 0;
  const r4 = await dispatchAction({ kind: "fill", value: "abc" }, deps);
  ok("fill → CDP 输入失败时回退 content 注值（两次都调用）", r4.ok && calls.includes("cdpType") && calls.includes("actInject"));
  calls.length = 0;
  for (const k of ["select", "check", "toggle", "scroll"]) {
    const r = await dispatchAction({ kind: k }, deps);
    ok(`${k} → 走 content 注值`, r.ok && calls.includes("actInject"));
    calls.length = 0;
  }
  const r5 = await dispatchAction({ kind: "read" }, deps);
  ok("read → 仅校验无动作", r5.ok && r5.noop === true);
  calls.length = 0;
  const r6 = await dispatchAction({ kind: "setDate", value: "2026-09-15" }, deps);
  ok("setDate 自定义日历 → 打开+定位+点选（CDP）", r6.ok && calls.includes("openDatePicker") && calls.includes("cdpClick"));
  const r7 = await dispatchAction({ kind: "setDate", value: "不是日期" }, deps);
  ok("setDate 无法解析日期 → 失败", !r7.ok);
  const r8 = await dispatchAction({ kind: "unknownverb" }, deps);
  ok("未注册动词 → 失败", !r8.ok);
}

console.log(`\n${fail ? "✗" : "✓"} test_taxonomy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
