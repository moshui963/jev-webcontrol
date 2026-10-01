/*
 * content.js — MAIN-world message handler for the automation tester.
 * Runs in the page, talks to the background service worker, and drives the
 * live DOM using window.__jevSnapshotExt (injected by snapshot_injected.js).
 */
(() => {
  "use strict";

  // Inject only once per frame (auto-injection + programmatic injection can stack).
  if (globalThis.__jevContentLoaded) return;
  globalThis.__jevContentLoaded = true;

  // Messaging requires the extension world. If we ever end up in the page's
  // MAIN world (no chrome.runtime), fail loudly instead of silently hanging.
  if (!chrome?.runtime?.onMessage) {
    console.warn("[jev-tester] content.js 运行在无 chrome.runtime 的世界（MAIN?），消息通道不可用");
    return;
  }

  const ext = () => globalThis.__jevSnapshotExt;
  let overlayEl = null;

  const send = (msg, keepOpen) => chrome.runtime.sendMessage(msg); // fire-and-forget where needed

  // Strip decorative tokens (icon-class names, dynamic badge counts like "(5)")
  // so fuzzy matching survives re-renders that change the exact accessible name.
  const normName = (s) =>
    String(s || "").replace(/caret-[\w-]+/gi, "").replace(/\(\d+\)/g, "").replace(/\s+/g, " ").trim();

  // Last-resort resolver: find a clickable candidate whose name contains the
  // meaningful phrase of the (now-stale) locator name. Returns the best match
  // or null. Used when the exact locator can no longer be resolved.
  function findClickableByText(text) {
    const lib = ext();
    if (!lib || !lib.collectCandidates) return null;
    const cand = [];
    lib.collectCandidates(document, "", cand);
    const phrase = normName(text);
    if (!phrase) return null;
    const tokens = phrase.split(/\s+/).filter(Boolean);
    let best = null, bestScore = -1, bestModal = false;
    for (const c of cand) {
      if (!c || !c.el) continue;
      let nm = "";
      try { nm = normName(lib.locatorOf(c.el).name || ""); } catch { nm = ""; }
      const score = tokens.filter((t) => nm.includes(t)).length;
      // Tie-break: with duplicated labels prefer the copy inside a visible
      // modal (the covered background copies are already pruned upstream).
      let modal = false;
      try { modal = !!lib.inVisibleModal && lib.inVisibleModal(c.el); } catch { modal = false; }
      if (score > bestScore || (score === bestScore && modal && !bestModal)) {
        bestScore = score; best = c.el; bestModal = modal;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function observe() {
    const e = ext();
    if (!e) return { ok: false, reason: "snapshot lib not ready" };
    const state = e.run();
    return { ok: true, state };
  }

  function evaluate(spec) {
    const e = ext();
    if (!e) return { ok: false, reason: "snapshot lib not ready" };
    return { ok: true, result: e.evaluateSpec(spec) };
  }

  // Resolve a click target like act() would (locator -> text fallback ->
  // climb from icon to text-bearing ancestor) but ONLY report its viewport
  // coordinates — the background then delivers a REAL click at that point
  // via chrome.debugger CDP input. No DOM event is synthesized here.
  function pointOf(action) {
    const e = ext();
    if (!e) return { ok: false, reason: "snapshot lib not ready" };
    if (!action || !action.locator) return { ok: false, reason: "no locator" };
    let el = e.resolve(document, action.locator);
    if (!el) el = findClickableByText(action.locator.name || action.label || action.text || "");
    if (!el) return { ok: false, reason: "element not found via locator (且文本回退未找到)", locator: action.locator };
    // A disabled control never receives trusted clicks / input events — fail
    // with a reason the panel can show, instead of a silent no-op.
    try {
      if (el.matches(":disabled") || el.closest("[aria-disabled='true']"))
        return {
          ok: false,
          reason: "目标处于禁用状态（disabled），操作无效——可能需要先完成前置操作（如勾选导出字段）",
          locator: action.locator,
        };
    } catch { /* unusual node — keep going */ }
    try {
      let target = el;
      if (!String(el.innerText || "").trim()) {
        let anc = el.parentElement;
        for (let i = 0; anc && i < 5; i++) {
          if (String(anc.innerText || "").trim()) { target = anc; break; }
          anc = anc.parentElement;
        }
      }
      target.scrollIntoView({ block: "center" });
      const r = target.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return { ok: false, reason: "目标元素无有效尺寸" };
      return {
        ok: true,
        cx: Math.round(r.x + r.width / 2),
        cy: Math.round(r.y + r.height / 2),
        label: String(target.innerText || "").trim().slice(0, 40),
      };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  function act(action) {
    const e = ext();
    if (!e) return { ok: false, reason: "snapshot lib not ready" };
    if (!action || !action.locator) return { ok: false, reason: "no locator" };
    let el = e.resolve(document, action.locator);
    // Fallback: the locator's name (e.g. "caret-down 销售管理 (5)") may not
    // match the live DOM exactly (dynamic badge counts, whitespace). Search the
    // page for a clickable element whose name contains the meaningful phrase.
    if (!el) el = findClickableByText(action.locator.name || action.label || action.text || "");
    if (!el) return { ok: false, reason: "element not found via locator (且文本回退未找到)", locator: action.locator };
    // A disabled control never receives trusted clicks / input events — fail
    // with a reason the panel can show, instead of a silent no-op.
    try {
      if (el.matches(":disabled") || el.closest("[aria-disabled='true']"))
        return {
          ok: false,
          reason: "目标处于禁用状态（disabled），操作无效——可能需要先完成前置操作（如勾选导出字段）",
          locator: action.locator,
        };
    } catch { /* unusual node — keep going */ }
    try {
      if (action.kind === "fill" || action.kind === "select") {
        // Only real form controls accept typing. Setting `.value` on e.g. an
        // <a> silently "succeeds" (expando property) but types nothing — a
        // false positive that once made a hot-search link pass a fill step.
        const editable =
          action.kind === "select"
            ? el.tagName === "SELECT"
            : el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
        if (!editable) {
          return { ok: false, reason: `目标不是可输入元素（<${el.tagName.toLowerCase()}），已取消填入`, kind: action.kind };
        }
        const val = action.value != null ? String(action.value) : "";
        const currentText = () => (el.isContentEditable ? (el.textContent || "") : (el.value || ""));
        const apply = () => {
          if (el.isContentEditable) {
            // contenteditable has NO .value property — assigning it only sets a
            // useless expando. Writing textContent is the only thing that sticks
            // (rich-text boxes, comment fields, Notion-like editors).
            el.textContent = val;
          } else {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
            if (setter && setter.set) { setter.set.call(el, val); } else { el.value = val; }
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        apply();
        // React/Vue controlled inputs can swallow the first programmatic set if
        // their change listener attached after mount — retry once before we
        // report success, and never claim success on a field that stayed empty.
        if (!currentText().includes(val)) apply();
        if (!currentText().includes(val)) {
          return { ok: false, reason: `填入失败：字段值未生效（当前「${currentText()}」≠ 期望「${val}」）`, kind: action.kind };
        }
        // submit=true (search steps): actually trigger the search — prefer the
        // enclosing form's submit button (e.g. 百度一下), fall back to Enter.
        if (action.submit) {
          let submitted = false;
          try {
            const form = el.closest && el.closest("form");
            const btn = form && form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
            if (btn && !btn.disabled) { btn.click(); submitted = true; }
          } catch { /* fall through to Enter */ }
          if (!submitted) {
            const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
            el.dispatchEvent(new KeyboardEvent("keydown", opts));
            el.dispatchEvent(new KeyboardEvent("keyup", opts));
          }
          return { ok: true, kind: "fill+submit", value: val, submitted };
        }
        return { ok: true, kind: "fill", value: val };
      }
      if (action.kind === "check" || action.kind === "toggle") {
        try {
          const on = action.checked != null ? !!action.checked : true;
          if (typeof el.checked === "boolean") {
            if (el.checked !== on) { el.checked = on; el.dispatchEvent(new Event("click", { bubbles: true })); }
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            // role=switch / 自定义开关：合成点击兜底（isTrusted 由 CDP 层提供）
            el.dispatchEvent(new Event("click", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return { ok: true, kind: action.kind, checked: on };
        } catch (e) { return { ok: false, reason: String(e), kind: action.kind }; }
      }
      if (action.kind === "scroll") {
        try {
          const delta = Number(action.delta) || 0;
          if (el.scrollHeight > el.clientHeight && Math.abs(delta) > 0) el.scrollTop += delta;
          else window.scrollBy(0, delta);
          return { ok: true, kind: "scroll", delta };
        } catch (e) { return { ok: false, reason: String(e), kind: "scroll" }; }
      }
      if (action.kind === "setRange") {
        try {
          const n = Number(action.value);
          if (el.type === "range" || el.getAttribute("role") === "slider") {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
            if (setter && setter.set) setter.set.call(el, n); else el.value = n;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, kind: "setRange", value: n };
          }
          return { ok: false, reason: "目标不是滑块/步进器", kind: "setRange" };
        } catch (e) { return { ok: false, reason: String(e), kind: "setRange" }; }
      }
      if (action.kind === "upload") {
        // 文件上传需通过 CDP 文件选择器注入本地路径，content 脚本无法安全设置
        // <input type=file>.value；此处明确返回未接入，避免静默失败。
        return { ok: false, reason: "文件上传需通过 CDP 文件选择器注入本地路径，暂未接入", kind: "upload" };
      }
      if (action.kind === "drag") {
        const src = action.from ? e.resolve(document, action.from) : el;
        if (!src) return { ok: false, reason: "drag 源元素未找到", kind: "drag" };
        const sRect = src.getBoundingClientRect();
        const sx = sRect.x + sRect.width / 2;
        const sy = sRect.y + sRect.height / 2;
        let tx = sx, ty = sy;
        if (action.to) {
          const dst = e.resolve(document, action.to);
          if (!dst) return { ok: false, reason: "drag 目标元素未找到", kind: "drag" };
          const dRect = dst.getBoundingClientRect();
          tx = dRect.x + dRect.width / 2;
          ty = dRect.y + dRect.height / 2;
        } else {
          tx = sx + (Number(action.dx) || 0);
          ty = sy + (Number(action.dy) || 0);
        }
        const fire = (type, x, y, btn) => {
          const target = document.elementFromPoint(x, y) || document.body;
          const ev = new MouseEvent(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: y, button: btn || 0, view: window,
          });
          target.dispatchEvent(ev);
        };
        fire("mousedown", sx, sy, 0);
        fire("mousemove", (sx + tx) / 2, (sy + ty) / 2, 0);
        fire("mousemove", tx, ty, 0);
        fire("mouseup", tx, ty, 0);
        return { ok: true, kind: "drag", from: action.from || action.locator, to: action.to || { dx: action.dx, dy: action.dy } };
      }
      // click 动作已统一改走 CDP 可信点击（background actOnTab → POINT → cdpClick），
      // 不再经此 ACT 合成事件路径 —— isTrusted=false 的点击在 SPA（如氚云）上点不动。
      if (action.kind === "click") {
        return { ok: false, reason: "click 已由 POINT+CDP 处理，不应直达 ACT 合成路径", kind: "click" };
      }
    } catch (err) {
      return { ok: false, reason: String(err), stack: err && err.stack };
    }
  }

  function drawOverlay(actions) {
    if (overlayEl && overlayEl.remove) overlayEl.remove();
    if (!actions || !actions.length) return;
    const root = document.documentElement;
    overlayEl = document.createElement("div");
    overlayEl.setAttribute("data-jev-overlay", "1");
    Object.assign(overlayEl.style, {
      position: "fixed", left: "0", top: "0", width: "100%", height: "100%",
      pointerEvents: "none", zIndex: "2147483646",
    });
    for (const a of actions) {
      const r = a.rect;
      if (!r) continue;
      const box = document.createElement("div");
      const color = a.scope && a.scope.includes("shadow") ? "#7c3aed"
        : a.scope && a.scope.startsWith("iframe") ? "#0891b2" : "#2563eb";
      Object.assign(box.style, {
        position: "absolute",
        left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px",
        border: "2px solid " + color, borderRadius: "3px",
        background: color + "22",
      });
      overlayEl.appendChild(box);
    }
    root.appendChild(overlayEl);
  }

  function clearOverlay() {
    if (overlayEl && overlayEl.remove) overlayEl.remove();
    overlayEl = null;
  }

  // ---------- 日期选择器相关（setDate 动词的执行支撑） ----------
  function dateEl(action) {
    const e = ext();
    if (!e) return null;
    let el = e.resolve(document, action.locator);
    if (!el) el = findClickableByText(action.locator.name || action.label || "");
    return el;
  }

  function readField(action) {
    const el = dateEl(action);
    if (!el) return { ok: false, reason: "未找到字段" };
    const v = el.isContentEditable ? (el.textContent || "") : (el.value || "");
    return { ok: true, value: v };
  }

  function isNativeDate(action) {
    const el = dateEl(action);
    const t = el && (el.type || "").toLowerCase();
    return { ok: !!(el && ["date", "datetime-local", "month", "week", "time"].includes(t)) };
  }

  function setDateNative(action, iso) {
    const el = dateEl(action);
    if (!el) return { ok: false, reason: "未找到日期字段" };
    try {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
      if (setter && setter.set) setter.set.call(el, iso); else el.value = iso;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: String(el.value || "").includes(iso) };
    } catch (e) { return { ok: false, reason: String(e) }; }
  }

  function openDatePicker(action) {
    const el = dateEl(action);
    if (!el) return { ok: false, reason: "未找到日期字段" };
    try { el.focus(); el.click(); return { ok: true }; } catch (e) { return { ok: false, reason: String(e) }; }
  }

  function findCalendarRoot() {
    const sel = '[role="dialog"], [role="grid"], [class*="picker"], [class*="calendar"], [class*="datepicker"]';
    const els = Array.from(document.querySelectorAll(sel));
    const hasDay = (el) => el.querySelector('[role="gridcell"], td, [class*="day"]');
    for (const el of els) {
      if (el.offsetParent !== null && hasDay(el)) return el;
    }
    for (const el of els) if (hasDay(el)) return el;
    return null;
  }

  function findDateCellInline(root, target) {
    const day = String(target.d);
    const cells = root.querySelectorAll('[role="gridcell"], td, [class*="day"], [class*="cell"], [class*="date"]');
    for (const el of cells) {
      const t = (el.textContent || "").trim();
      if (t !== day && t !== (target.d < 10 ? "0" + day : day)) continue;
      const cls = (el.className || "").toLowerCase();
      const dis = el.getAttribute && el.getAttribute("aria-disabled") === "true";
      if (dis || /disabled|outside|prev|next|empty|other/.test(cls) || (el.getAttribute && el.getAttribute("aria-hidden") === "true")) continue;
      return el;
    }
    return null;
  }

  function resolveDateCell(target) {
    const root = findCalendarRoot();
    if (!root) return { ok: false, reason: "未找到日历弹层" };
    const cell = findDateCellInline(root, target);
    if (!cell) return { ok: false, reason: "日历中未找到目标日" };
    try {
      cell.scrollIntoView({ block: "center" });
      const r = cell.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return { ok: false, reason: "目标日无有效尺寸" };
      return { ok: true, cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
    } catch (e) { return { ok: false, reason: String(e) }; }
  }

  function clickDateNav(dir) {
    const root = findCalendarRoot();
    if (!root) return { ok: false, reason: "未找到日历弹层" };
    const btns = Array.from(root.querySelectorAll('button, [role="button"], [aria-label]'));
    const re = dir < 0 ? /上|左|前|prev|previous|«|<|arrowleft/i : /下|右|后|next|»|>|arrowright/i;
    for (const b of btns) {
      const t = (b.textContent || "") + " " + (b.getAttribute && b.getAttribute("aria-label") || "");
      if (re.test(t) && !/disabled/.test((b.className || "").toLowerCase())) { b.click(); return { ok: true }; }
    }
    return { ok: false, reason: "未找到翻月按钮" };
  }

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || !msg.type) return;
    try {
      if (msg.type === "PING") return respond({ ok: true, ready: !!ext() });
      if (msg.type === "OBSERVE") return respond(observe());
      if (msg.type === "EVALUATE") return respond(evaluate(msg.spec));
      if (msg.type === "ACT") return respond(act(msg.action));
      if (msg.type === "POINT") return respond(pointOf(msg.action));
      if (msg.type === "READ_FIELD") return respond(readField(msg.action));
      if (msg.type === "IS_NATIVE_DATE") return respond(isNativeDate(msg.action));
      if (msg.type === "SET_DATE_NATIVE") return respond(setDateNative(msg.action, msg.iso));
      if (msg.type === "OPEN_DATE_PICKER") return respond(openDatePicker(msg.action));
      if (msg.type === "RESOLVE_DATE_CELL") return respond(resolveDateCell(msg.target));
      if (msg.type === "CLICK_DATE_NAV") return respond(clickDateNav(msg.dir));
      if (msg.type === "OVERLAY") { drawOverlay(msg.actions); return respond({ ok: true }); }
      if (msg.type === "CLEAR_OVERLAY") { clearOverlay(); return respond({ ok: true }); }
    } catch (err) {
      respond({ ok: false, reason: String(err) });
    }
    return false; // no async respond
  });
})();
