// lib/actions/registry.js
// 动作执行「统一入口」。每个执行 verb 对应一个 executor，执行层不再散落 switch。
//
// 设计（对齐用户决策）：
//   - 默认全部走 CDP（chrome.debugger Input.*），content-script 注值仅作 fill/原生日期的兜底
//   - executor 不直接依赖 chrome.*，而是接收一个 deps 对象（由 background 注入 cdpClick/
//     cdpHover/cdpDrag/cdpType/sendToTab 等）。这样纯逻辑可被 jsdom 单测。
//
// 新增一类元素 = 在 element-taxonomy.js 加 detect + 在这里加一个 executor，不散落改三处。

import { ACTION_VERBS } from "../element-taxonomy.js";

// ---------- 纯函数：便于单测 ----------

// 解析多种日期写法 → {y,m,d}（数字）。支持 2026-09-01 / 2026/9/1 / 2026.9.1 / 2026年9月1日 / 9/1/2026
export function normalizeDate(str) {
  const s = String(str || "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); // m/d/y
  if (m) return { y: +m[3], m: +m[1], d: +m[2] };
  return null;
}

// 在日历 DOM 中定位目标天数格 → 元素或 null。
// 兼容 role=gridcell / <td> / 含 day|cell|date 类名的节点；跳过禁用/非本月/上下月导航格。
export function findDateCell(root, target) {
  if (!root || !target) return null;
  const day = String(target.d);
  const candidates = root.querySelectorAll('[role="gridcell"], td, [class*="day"], [class*="cell"], [class*="date"]');
  for (const el of candidates) {
    const t = (el.textContent || "").trim();
    if (t !== day && t !== (target.d < 10 ? "0" + day : day)) continue;
    const cls = (el.className || "").toLowerCase();
    const dis = el.getAttribute && (el.getAttribute("aria-disabled") === "true" || el.disabled);
    if (dis) continue;
    if (/disabled|outside|prev|next|empty|other/.test(cls)) continue;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") continue;
    return el;
  }
  return null;
}

// 读取日历当前显示的年月 → {y,m} 或 null（用于决定翻月方向）。
export function readDatePickerMonth(root) {
  if (!root) return null;
  const heads = root.querySelectorAll("*");
  for (const el of heads) {
    const t = (el.textContent || "").trim();
    let m = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (m) return { y: +m[1], m: +m[2] };
    m = t.match(/(\d{4})[-/.](\d{1,2})/);
    if (m && /(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(t)) {
      const months = { january:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
      const name = t.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)/i);
      if (name) return { y: +m[1], m: months[name[1].toLowerCase()] };
    }
  }
  return null;
}

// 把一段文本拆成 CDP Input.dispatchKeyEvent 序列（逐字符 keyDown/keyUp）。
// 背景的 cdpType 使用它；这里只负责生成事件描述。
export function buildKeyEvents(text) {
  const out = [];
  for (const ch of String(text)) {
    if (ch === "\n") {
      out.push({ type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
      out.push({ type: "keyUp", key: "Enter", code: "Enter", text: "\r" });
      continue;
    }
    out.push({ type: "keyDown", key: ch, code: codeFor(ch), text: ch });
    out.push({ type: "keyUp", key: ch, code: codeFor(ch), text: ch });
  }
  return out;
}

function codeFor(ch) {
  if (/[a-z]/.test(ch)) return "Key" + ch.toUpperCase();
  if (/[A-Z]/.test(ch)) return "Key" + ch;
  if (/[0-9]/.test(ch)) return "Digit" + ch;
  return "";
}

// ---------- executors ----------

async function execClick({ action, deps }) {
  const pt = await deps.point(action);
  if (!pt || !pt.ok) return { ok: false, kind: "click", reason: (pt && pt.reason) || "无法定位点击坐标" };
  if (!deps.cdpClick) return { ok: false, kind: "click", reason: "cdpClick 不可用" };
  await deps.cdpClick(pt.cx, pt.cy);
  return { ok: true, kind: "click", via: "cdp", cx: pt.cx, cy: pt.cy, label: pt.label };
}

async function execFill({ action, deps }) {
  const value = action.value != null ? String(action.value) : "";
  if (!value) return { ok: false, reason: "fill 无 value" };
  const pt = await deps.point(action);
  let via = "inject";
  if (pt && pt.ok) {
    if (deps.cdpClick) await deps.cdpClick(pt.cx, pt.cy); // 聚焦
    if (deps.cdpType) {
      await deps.cdpType(pt.cx, pt.cy, value); // CDP 逐字符输入（忠实）
      const cur = deps.readField ? deps.readField(action) : "";
      if (String(cur).includes(value)) via = "cdp";
    }
  }
  if (via === "inject") {
    if (!deps.actInject) return { ok: false, reason: "actInject 不可用（fill 兜底失败）" };
    const r = await deps.actInject({ ...action, kind: "fill" });
    if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "fill 注入失败" };
    return { ok: true, kind: "fill", via: "inject", value };
  }
  return { ok: true, kind: "fill", via: "cdp", value };
}

async function execSetDate({ action, deps }) {
  const text = action.value != null ? String(action.value) : "";
  const parsed = normalizeDate(text);
  if (!parsed) return { ok: false, reason: `无法解析日期: ${text}` };
  const iso = `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;

  // 1) 原生 date 输入：CDP 输入「YYYY-MM-DD」优先，content 注值兜底
  //    注意：isNativeDate 是异步函数，必须 await —— 否则拿到的是 Promise（永远 truthy），
  //    会导致自定义日历（AntD/Element）被误判成原生 input 而永远走不到「打开日历」分支。
  const isNative = deps.isNativeDate ? await deps.isNativeDate(action) : false;
  if (isNative) {
    const pt = await deps.point(action);
    if (pt && pt.ok && deps.cdpType) {
      await deps.cdpClick(pt.cx, pt.cy);
      await deps.cdpType(pt.cx, pt.cy, iso);
      const v = deps.readField ? deps.readField(action) : "";
      if (String(v).includes(iso)) return { ok: true, kind: "setDate", via: "cdp", iso };
    }
    const r = deps.setDateNative ? await deps.setDateNative(action, iso) : { ok: false };
    if (r && r.ok) return { ok: true, kind: "setDate", via: "inject", iso };
    return { ok: false, reason: "原生日期输入赋值失败" };
  }

  // 2) 自定义日历弹层：打开 → 定位天数格 → 点中；月份不符则翻月后重试
  const opened = deps.openDatePicker ? await deps.openDatePicker(action) : { ok: false };
  if (!opened || !opened.ok) return { ok: false, reason: "无法打开日期选择器" };
  for (let i = 0; i < 13; i++) {
    const cell = deps.resolveDateCell ? await deps.resolveDateCell(parsed) : null;
    if (cell && Number.isFinite(cell.cx)) {
      await deps.cdpClick(cell.cx, cell.cy);
      return { ok: true, kind: "setDate", via: "cdp", iso };
    }
    const dir = deps.dateNavHint ? deps.dateNavHint(parsed) : (i % 2 === 0 ? -1 : 1);
    if (deps.clickDateNav) {
      const ok = await deps.clickDateNav(dir);
      if (!ok || !ok.ok) break;
    } else break;
    if (deps.sleep) await deps.sleep(150);
  }
  return { ok: false, reason: "日历中未找到目标日期" };
}

async function execHover({ action, deps }) {
  const pt = await deps.point(action);
  if (!pt || !pt.ok) return { ok: false, kind: "hover", reason: (pt && pt.reason) || "无法定位坐标" };
  if (!deps.cdpHover) return { ok: false, kind: "hover", reason: "cdpHover 不可用" };
  await deps.cdpHover(pt.cx, pt.cy);
  return { ok: true, kind: "hover", via: "cdp", cx: pt.cx, cy: pt.cy };
}

async function execDrag({ action, deps }) {
  const from = await deps.point(action);
  if (!from || !from.ok) return { ok: false, kind: "drag", reason: "drag 起点无法定位" };
  let to = null;
  if (action.to) to = await deps.point({ ...action, locator: action.to });
  else if (action.dx != null || action.dy != null) to = { ok: true, cx: from.cx + (Number(action.dx) || 0), cy: from.cy + (Number(action.dy) || 0) };
  if (!to || !to.ok) return { ok: false, kind: "drag", reason: "drag 终点无法定位" };
  if (!deps.cdpDrag) return { ok: false, kind: "drag", reason: "cdpDrag 不可用" };
  await deps.cdpDrag({ x: from.cx, y: from.cy }, { x: to.cx, y: to.cy });
  return { ok: true, kind: "drag", from: action.locator, to: action.to || { dx: action.dx, dy: action.dy } };
}

function injectKind(kind) {
  return async ({ action, deps }) => {
    if (!deps.actInject) return { ok: false, kind, reason: "actInject 不可用" };
    const r = await deps.actInject({ ...action, kind });
    return r && r.ok ? { ok: true, kind, ...r } : { ok: false, kind, reason: (r && r.reason) || "执行失败" };
  };
}

async function execRead({ action }) {
  return { ok: true, kind: "read", noop: true, target: action.label || action.target || "" };
}

const executors = {
  click: execClick,
  fill: execFill,
  setDate: execSetDate,
  hover: execHover,
  drag: execDrag,
  select: injectKind("select"),
  check: injectKind("check"),
  toggle: injectKind("toggle"),
  setRange: injectKind("setRange"),
  upload: injectKind("upload"),
  scroll: injectKind("scroll"),
  read: execRead,
};

export function registerExecutor(verb, fn) { executors[verb] = fn; }
export function knownVerbs() { return Object.keys(executors); }

// 统一入口：background 的 actOnTab 改为调用它。
export async function dispatchAction(action, deps = {}) {
  if (!action || !action.kind) return { ok: false, reason: "无动作类型(kind)" };
  const fn = executors[action.kind];
  if (!fn) return { ok: false, reason: `未注册的动作类型: ${action.kind}` };
  try {
    return await fn({ action, deps });
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// 自检：注册表必须覆盖全部动词表，否则说明有动词没执行器。
export function coverageOk() {
  return ACTION_VERBS.every((v) => typeof executors[v] === "function");
}
