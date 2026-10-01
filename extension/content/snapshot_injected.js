/*
 * snapshot_injected.js — page-world snapshot + durable locator core.
 * Reused verbatim from scripts/snapshot_extended.js (M1 perception extension).
 * Runs in MAIN world so it sees the real DOM / shadow roots / same-origin iframes.
 * Exposes window.__jevSnapshotExt = { run, locatorOf, resolve, evaluateSpec }.
 */
(() => {
  "use strict";
  if (!document || !document.body) return null;

  const cache = (window.__jevFast ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identity = (e) => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e);
    cache.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);

  const safe = (e) => !["password", "file", "hidden"].includes(e.type);
  const visible = (e) => {
    if (e.closest('[aria-hidden="true"],[inert]')) return false;
    if (typeof e.checkVisibility === "function") {
      try {
        return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      } catch {
        return true;
      }
    }
    return true;
  };

  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return "";
    seen.add(e);
    const referenced = (e.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => name((e.ownerDocument || document).getElementById(id), seen))
      .filter(Boolean)
      .join(" ");
    return (
      referenced ||
      e.getAttribute("aria-label") ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(" ") ||
      (["button", "submit", "reset"].includes(e.type) ? e.value : "") ||
      e.getAttribute("alt") ||
      (e.tagName === "INPUT"
        ? ""
        : [...e.childNodes]
            .map((n) =>
              n.nodeType === 3
                ? n.textContent
                : n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true"
                  ? name(n, seen)
                  : ""
            )
            .join(" ")
            .trim()) ||
      e.getAttribute("title") ||
      e.getAttribute("placeholder") ||
      ""
    );
  };

  const roles = [
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio",
    "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton",
  ];
  const selector =
    "a[href],button,input,textarea,select,summary,[contenteditable='true'],[onclick]," +
    ".button,.btn,.ant-btn,.ant-btn-primary,.ant-btn-text,.el-button," +
    roles.map((role) => "[role='" + role + "']").join(",");

  // Stable, human-friendly label for an editable field. The generic `name()`
  // above may resolve an <input>'s accessible name to its CURRENT value (e.g.
  // Baidu's search box is aria-labelledby a hot-search phrase), which makes the
  // snapshot show "fill · 税务部门曝光..." instead of "搜索框". We deliberately
  // ignore the live value and prefer placeholder / id-derived names so the
  // field is recognizable and the decider can score it as a search box.
  // Resolve the text of a <label> associated with a field (label[for=id] or a
  // wrapping <label>). This is the most reliable human name for an input and lets
  // the decider tell "用户名" from "密码" instead of two bare "输入框".
  const labelFor = (e) => {
    try {
      const id = e.id;
      if (id) {
        const lab = document.querySelector('label[for="' + String(id).replace(/"/g, '\\"') + '"]');
        if (lab) return (lab.textContent || "").trim().replace(/\s+/g, " ");
      }
      const wrap = e.closest && e.closest("label");
      if (wrap) return (wrap.textContent || "").trim().replace(/\s+/g, " ");
    } catch { /* selector edge cases — ignore */ }
    return "";
  };
  const fieldLabel = (e) => {
    const lab = labelFor(e);
    if (lab) return lab;
    const aria = e.getAttribute("aria-label");
    if (aria) return aria.trim();
    const ph = e.getAttribute("placeholder");
    if (ph) return ph.trim();
    const key = (e.id || e.getAttribute("name") || "").toLowerCase();
    if (/(^kw$|^wd$|^q$|^query$|^keyword$|search|输入|sbox|inputbox)/.test(key)) return "搜索框";
    if (key) return "输入框(" + key + ")";
    const t = e.getAttribute("title") || e.getAttribute("alt");
    if (t) return t.trim();
    return "输入框";
  };

  const role = (e) => {
    const explicit = e.getAttribute("role");
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === "BUTTON" || e.tagName === "SUMMARY") return "button";
    if (e.tagName === "A") return "link";
    if (e.tagName === "SELECT") return "combobox";
    if (e.tagName === "TEXTAREA" || e.isContentEditable) return "textbox";
    if (e.tagName === "INPUT") {
      if (["checkbox", "radio"].includes(e.type)) return e.type;
      if (["button", "submit", "reset", "image"].includes(e.type)) return "button";
      if (e.type === "search") return "searchbox";
      if (e.type === "number") return "spinbutton";
      if (["text", "email", "url", "tel"].includes(e.type)) return "textbox";
    }
    return null;
  };

  // JS-driven pages (low-code platforms like h3yun) render whole card grids as
  // plain <div>s with click handlers — no <button>, no role, nothing the
  // selector above matches. The one reliable tell is the computed cursor:
  // elements the page shows a pointer hand for behave like buttons. Requires
  // some identifying content (text / title / aria-label / an image) so random
  // hover-styled wrappers don't flood the snapshot. Cached per element.
  const roleCache = new WeakMap();
  // Single clickable-predicate source, injected verbatim from lib/dom-cues.js
  // (markers DOM_CUES_START / DOM_CUES_END wrap the copy so a drift test can
  // assert it stays identical to the canonical source). The DOM probe shares
  // the SAME source so the two engines never disagree on what is clickable —
  // that divergence was the root cause of "probe missed the styled-div button".
  const isButtonLike = /*DOM_CUES_START*/function isButtonLikeSrc(e) {
    try {
      const t = (e.tagName || "").toUpperCase();
      const role = e.getAttribute && e.getAttribute("role");
      const cls = ((e.getAttribute && e.getAttribute("class")) || "").toLowerCase();
      const classIsBtn = /\b(button|btn|ant-btn|ant-btn-primary|ant-btn-text|el-button|ivu-btn)\b/.test(cls);
      let pointer = false;
      try { pointer = getComputedStyle(e).cursor === "pointer"; } catch (e2) { /* detached node */ }
      if (
        t === "A" || t === "BUTTON" ||
        role === "button" || role === "menuitem" || role === "option" ||
        e.onclick || (e.getAttribute && e.getAttribute("tabindex") === "0") ||
        classIsBtn || pointer
      ) {
        return true;
      }
    } catch (e3) { /* noop */ }
    return false;
  }/*DOM_CUES_END*/;

  // Single element/action classifier source, injected verbatim from
  // lib/element-taxonomy.js (markers CLASSIFY_START / CLASSIFY_END wrap the copy
  // so a drift test asserts it stays identical to the canonical source). The DOM
  // probe and collector share the SAME classifier — diverging copies were the
  // root cause of "probe missed the styled-div button" in v0.4.22.
  const classifyElement = /*CLASSIFY_START*/function classifyElement(el) {
  if (!el || !el.tagName) return null;
  const tag = el.tagName.toUpperCase();
  const attr = (k) => (el.getAttribute ? el.getAttribute(k) : null);
  const type = (el.type || "").toLowerCase();
  const role = attr("role");
  const cls = (attr("class") || "").toLowerCase();

  const cats = [
    {
      id: "activation", kind: "click", conf: (() => {
        if (tag === "BUTTON" || tag === "A" || role === "button" || role === "menuitem" || role === "tab") return 0.95;
        if (/(^|[\s-])(button|btn|ant-btn|el-button|ivu-btn)\b/.test(cls) && tag !== "INPUT" && tag !== "TEXTAREA") return 0.8;
        return 0;
      })(),
    },
    {
      id: "text", kind: "fill", conf: (() => {
        if (tag === "TEXTAREA") return 0.95;
        if (tag === "INPUT" && !["checkbox", "radio", "file", "range", "submit", "button", "hidden", "reset", "image"].includes(type) && !type.startsWith("date") && type !== "datetime-local" && type !== "month" && type !== "week" && type !== "time") return 0.9;
        if (el.isContentEditable) return 0.9;
        if (role === "textbox" || role === "searchbox") return 0.9;
        return 0;
      })(),
    },
    {
      id: "selection", kind: "select", conf: (() => {
        if (tag === "SELECT") return 0.95;
        if (tag === "INPUT" && (type === "checkbox" || type === "radio")) return 0.9;
        if (role === "switch" || role === "checkbox") return 0.85;
        if (role === "combobox" || role === "listbox") return 0.8;
        return 0;
      })(),
    },
    {
      // 调节类有两种 verb：日期类 → setDate，滑块类 → setRange。
      // kind 必须按命中分支动态取，不能写死成 setDate（否则 range 会被误判成 setDate）。
      id: "adjust",
      kind: (() => {
        if (["date", "datetime-local", "month", "week", "time"].includes(type)) return "setDate";
        if (type === "range" || role === "slider") return "setRange";
        return null;
      })(),
      conf: (() => {
        if (["date", "datetime-local", "month", "week", "time"].includes(type)) return 0.95; // setDate
        if (type === "range" || role === "slider") return 0.9; // setRange
        return 0;
      })(),
    },
    {
      id: "reveal", kind: "hover", conf: (() => {
        if ((attr("aria-haspopup") || attr("data-hover")) && (role === "menuitem" || tag === "LI" || tag === "DIV" || role === "button")) return 0.6;
        return 0;
      })(),
    },
    {
      id: "drag", kind: "drag", conf: (() => {
        if (attr("draggable") === "true" || role === "slider") return 0.7;
        return 0;
      })(),
    },
    {
      id: "file", kind: "upload", conf: (tag === "INPUT" && type === "file" ? 0.98 : 0),
    },
    {
      id: "observe", kind: "read", conf: (() => {
        if (role === "progressbar" || role === "status" || role === "alert") return 0.8;
        if (tag === "PROGRESS" || tag === "METER") return 0.85;
        return 0;
      })(),
    },
  ];

  let best = null;
  for (const c of cats) {
    if (c.conf > 0 && c.kind && (!best || c.conf > best.conf)) best = c;
  }
  // label 直接用 id 以保证本函数自包含（可 toString() 注入收集器，不依赖外部 CATEGORY_LABELS）。
  return best ? { category: best.id, label: best.id, kind: best.kind, conf: best.conf } : null;
}/*CLASSIFY_END*/;

  const effectiveRole = (e) => {
    if (roleCache.has(e)) return roleCache.get(e);
    let r = role(e);
    if (!r && isButtonLike(e) &&
      ((e.innerText || "").trim() || e.getAttribute("title") || e.getAttribute("aria-label") || e.querySelector("img"))) {
      r = "button";
    }
    roleCache.set(e, r);
    return r;
  };

  const cssLabel = (e) => {
    const t = e.tagName.toLowerCase();
    const id = e.id ? "#" + e.id : "";
    const cls = (e.getAttribute("class") || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 1)
      .map((c) => "." + c)
      .join("");
    return (t + id + cls) || t;
  };

  const inOpenShadow = (e) => e.shadowRoot && e.shadowRoot.mode === "open";
  const sameOriginDoc = (frame) => {
    try {
      return frame.contentDocument || null;
    } catch {
      return null;
    }
  };

  // Hit-test: is something else stacked on top of the element's center point
  // (modal mask, sticky header, an open dropdown panel)? Such elements cannot
  // receive a real click — a trusted CDP click dispatched at those coordinates
  // lands on the overlay and is swallowed. Dropping them fixes duplicated
  // labels too: with the export dialog open, the masked OLD "导出" behind it
  // used to win exact-name resolution purely by document order (dialogs are
  // appended at the END of body, so the covered copy comes first).
  const composedChain = (node) => {
    const chain = [];
    let n = node;
    while (n) {
      chain.push(n);
      n = n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode;
    }
    return chain;
  };
  const isCovered = (el) => {
    try {
      if (el.ownerDocument !== document || !visible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      // Probe FIVE points (center + inner quadrants): a single center probe
      // mis-prunes real buttons when a decorative corner grip / badge /
      // sibling tooltip happens to sit exactly there (the export dialog's
      // footer 导出/取消 vanished from the tree for exactly this reason).
      const pts = [
        [r.x + r.width / 2, r.y + r.height / 2],
        [r.x + r.width * 0.3, r.y + r.height * 0.3],
        [r.x + r.width * 0.7, r.y + r.height * 0.3],
        [r.x + r.width * 0.3, r.y + r.height * 0.7],
        [r.x + r.width * 0.7, r.y + r.height * 0.7],
      ];
      const ec = composedChain(el);
      let probed = 0;
      for (const [cx, cy] of pts) {
        if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
        const hit = document.elementFromPoint(cx, cy);
        if (!hit) continue;
        probed++;
        if (hit === el) return false;
        const hc = composedChain(hit);
        // hit is the element itself, a descendant (icon/badge drawn over it), or
        // an ancestor (wrapper) -> nothing foreign is blocking the click.
        if (hc.includes(el) || ec.includes(hit)) return false;
        // Modal-internal tolerance: when BOTH the element and whatever covers
        // it live inside the SAME visible dialog, the overlap is almost always
        // a rendering artifact (entry animation transform / decorative layer),
        // not a real mask — the export dialog's footer 导出 was pruned this way
        // while its sibling 取消 survived. Background elements covered BY the
        // modal are unaffected: they sit outside the dialog container.
        const mEl = el.closest && el.closest(MODAL_SEL);
        if (mEl && hit.closest && hit.closest(MODAL_SEL) === mEl) return false;
      }
      // Every in-viewport probe hit something foreign -> covered. Fully
      // scrolled-out elements (no probe landed) are NOT covered here; run()'s
      // viewport filter handles them.
      return probed > 0;
    } catch {
      return false;
    }
  };

  // ===========================================================================
  // Candidate resolver — applied per scope, in ONE ordered pass so the "is this
  // element a real click target?" decision is centralized instead of hand-tuned
  // per site. Each concern below was historically a separate patch; now they are
  // one pipeline (the order matters):
  //   (1) MENU EXPANSION  — a role-less container with >=3 text leaves and no
  //       real controls is a LIST, not a button: expand it into its items
  //       (百家号"新的创作"弹窗塌缩成拼贴大按钮的问题归到这里统一处理).
  //   (2) KEEP-INNERMOST + RESIDUAL — drop a candidate that wraps another ONLY
  //       when it carries no own label beyond the inner one (pure wrapper /
  //       nested same-label, e.g. h3yun 导出数据 tab 的 div 套 [role=tab]);
  //       keep BOTH when the outer has its own purpose (a card that also holds a
  //       删除 button) so the card's own click stays a target.
  //   (3) OCCLUSION       — drop elements stacked under a modal/overlay so the
  //       tree only shows what the user can actually click (isCovered).
  // ===========================================================================
  const STRONG_CTRL_SEL = "a[href],button,input,textarea,select,summary,label";
  const MENU_MIN_LEAVES = 3;

  // Innermost text leaves of e (elements whose own text is non-empty and whose
  // children carry no extra text). For each leaf we also return the smallest
  // ancestor within e that is the clickable "item" for that leaf (same text,
  // no extra wrapper) — usually the item's own <div>, not the bare text span.
  const innermostMenuLeaves = (e) => {
    const res = [];
    const seen = new Set();
    for (const d of e.querySelectorAll("*")) {
      const t = (d.innerText || "").trim();
      if (!t || seen.has(t)) continue;
      if ([...d.children].some((c) => ((c.innerText || "") + "").trim())) continue; // not innermost
      seen.add(t);
      let item = d;
      const p = d.parentElement;
      if (p && p !== e && (p.innerText || "").trim() === t) item = p; // item wrapper carries same text
      res.push(item);
    }
    return res;
  };
  const isMenuWrapper = (e) => {
    if (role(e)) return false; // native semantics (button/a/[role]) always stay
    try {
      if (e.querySelector(STRONG_CTRL_SEL)) return false; // real controls inside -> keep wrapper
    } catch {
      return false;
    }
    return innermostMenuLeaves(e).length >= MENU_MIN_LEAVES;
  };

  const resolveScope = (out, scopePrefix) => {
    const itemsOf = () => out.filter((c) => c.scope === scopePrefix);
    // (1) expand menu wrappers into their items
    for (let i = out.length - 1; i >= 0; i--) {
      const c = out[i];
      if (c.scope !== scopePrefix || !isMenuWrapper(c.el)) continue;
      out.splice(i, 1);
      for (const item of innermostMenuLeaves(c.el)) out.push({ el: item, scope: scopePrefix });
    }
    // (2) keep-innermost: drop a wrapper A when it contains another candidate B
    //     and A's label, minus all contained candidates' labels, is empty.
    {
      const drop = new Set();
      const list = itemsOf();
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      for (let a = 0; a < list.length; a++) {
        const A = list[a];
        if (drop.has(A.el)) continue;
        for (let b = 0; b < list.length; b++) {
          if (a === b) continue;
          const B = list[b];
          if (drop.has(B.el) || !A.el.contains(B.el)) continue;
          let residual = norm(name(A.el));
          for (const C of list) {
            if (C === A) continue;
            if (A.el.contains(C.el)) residual = residual.split(norm(name(C.el))).join("");
          }
          if (!residual.replace(/\s+/g, "")) { drop.add(A.el); break; }
        }
      }
      if (drop.size) {
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i].scope === scopePrefix && drop.has(out[i].el)) out.splice(i, 1);
        }
      }
    }
    // (3) occlusion — drop covered elements (a modal masks the page behind it)
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].scope === scopePrefix && isCovered(out[i].el)) out.splice(i, 1);
    }
  };

  const collectCandidates = (rootDoc, scopePrefix, out) => {
    if (!rootDoc) return;
    if (rootDoc.nodeType === 9 && !rootDoc.body) return;
    // --- enumerate a generous candidate set ---
    // (a) explicit interactive selectors (button / a[href] / [role] / [onclick] /
    //     .btn-class / ...). (b) cursor-pointer heuristic: plain elements that
    //     BEHAVE like buttons. Document order + hoist => ONE candidate per
    //     clickable region (a card, not one per text span inside it).
    const batch = new Set();
    for (const e of rootDoc.querySelectorAll(selector)) batch.add(e);
    const scanRoot = rootDoc.nodeType === 9 ? rootDoc.body : rootDoc;
    let extra = 0;
    for (const e of scanRoot.querySelectorAll("*")) {
      if (extra >= 200) break; // bounded: heuristic must not flood the snapshot
      if (batch.has(e)) continue;
      if (effectiveRole(e) !== "button") continue;
      let hoisted = false;
      for (let p = e.parentElement; p; p = p.parentElement) {
        if (batch.has(p)) { hoisted = true; break; }
      }
      if (hoisted) continue;
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.height > innerHeight * 0.8) continue; // skip giant wrappers
      batch.add(e);
      extra++;
    }
    for (const el of batch) out.push({ el, scope: scopePrefix });
    // --- resolve this scope (menu expansion -> keep-innermost -> occlusion) ---
    resolveScope(out, scopePrefix);
    for (const e of rootDoc.querySelectorAll("*")) {
      if (inOpenShadow(e)) {
        collectCandidates(e.shadowRoot, scopePrefix + cssLabel(e) + "::shadow/", out);
      }
    }
    let idx = 0;
    for (const frame of rootDoc.querySelectorAll("iframe")) {
      const child = sameOriginDoc(frame);
      if (child) collectCandidates(child, scopePrefix + "iframe[" + idx++ + "]/", out);
    }
  };

  const collectText = (rootDoc, words, budget, length) => {
    if (!rootDoc || !rootDoc.body) return length;
    const walker = rootDoc.createTreeWalker(rootDoc.body, NodeFilter.SHOW_TEXT);
    const range = rootDoc.createRange();
    let node;
    while ((node = walker.nextNode()) && length < budget) {
      const value = node.textContent.trim();
      const parent = node.parentElement;
      if (!value || !parent || parent.closest("script,style,noscript,template") || !visible(parent)) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect?.() || { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
        words.push(value);
        length += value.length;
      }
    }
    for (const e of rootDoc.querySelectorAll("*")) {
      if (inOpenShadow(e)) length = collectText(e.shadowRoot, words, budget, length);
    }
    for (const frame of rootDoc.querySelectorAll("iframe")) {
      const child = sameOriginDoc(frame);
      if (child) length = collectText(child, words, budget, length);
    }
    return length;
  };

  const attrEscape = (v) => String(v).replace(/"/g, '\\"');

  const stableCssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      if (node === (node.ownerDocument || document).documentElement) break;
      const tag = node.tagName.toLowerCase();
      let nth = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) nth++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(nth > 1 ? tag + ":nth-of-type(" + nth + ")" : tag);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const currentScopeOf = (el) => {
    let scope = "";
    let root = el.getRootNode();
    while (root && root !== document) {
      if (root.nodeType === 11 && root.host) {
        scope = cssLabel(root.host) + "::shadow/" + scope;
        root = root.host.getRootNode();
      } else break;
    }
    let win = el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const frameEl = win.frameElement;
      const idx = [...frameEl.ownerDocument.querySelectorAll("iframe")].indexOf(frameEl);
      scope = "iframe[" + idx + "]/" + scope;
      win = frameEl.ownerDocument.defaultView;
    }
    return scope;
  };

  const parseScope = (scope) => {
    const steps = [];
    for (const seg of (scope || "").split("/")) {
      if (!seg) continue;
      const m = seg.match(/^iframe\[(\d+)\]$/);
      if (m) steps.push({ type: "iframe", index: +m[1] });
      else if (seg.endsWith("::shadow")) steps.push({ type: "shadow", selector: seg.slice(0, -"::shadow".length) });
    }
    return steps;
  };

  const locatorOf = (el) => {
    const r = effectiveRole(el);
    const label = name(el);
    const strategies = [];
    if (r && label) strategies.push({ type: "semantic", role: r, name: label, confidence: "high" });
    if (el.id) strategies.push({ type: "css", selector: '[id="' + attrEscape(el.id) + '"]', confidence: "high" });
    const tid = el.getAttribute("data-testid") || el.getAttribute("data-cy") || el.getAttribute("data-test");
    if (tid) strategies.push({ type: "css", selector: '[data-testid="' + attrEscape(tid) + '"]', confidence: "high" });
    if (el.getAttribute("name")) strategies.push({ type: "css", selector: '[name="' + attrEscape(el.getAttribute("name")) + '"]', confidence: "medium" });
    if (el.getAttribute("aria-label")) strategies.push({ type: "css", selector: '[aria-label="' + attrEscape(el.getAttribute("aria-label")) + '"]', confidence: "medium" });
    strategies.push({ type: "css-path", selector: stableCssPath(el), confidence: "low" });
    return { role: r, name: label, scope: currentScopeOf(el), strategies };
  };

  const resolve = (rootDoc, locator) => {
    let doc = rootDoc;
    for (const step of parseScope(locator.scope || "")) {
      if (step.type === "iframe") {
        const frame = doc.querySelectorAll("iframe")[step.index];
        doc = sameOriginDoc(frame);
      } else {
        const host = doc.querySelector(step.selector);
        doc = host && host.shadowRoot ? host.shadowRoot : null;
      }
      if (!doc) return null;
    }
    for (const s of locator.strategies) {
      let found = null;
      if (s.type === "css" || s.type === "css-path") {
        try { found = doc.querySelector(s.selector); } catch { found = null; }
      } else if (s.type === "semantic") {
        const cand = [];
        collectCandidates(doc, "", cand);
        const norm = (n) => String(n || "").replace(/caret-[\w-]+/gi, "").replace(/\(\d+\)/g, "").replace(/\s+/g, " ").trim();
        const sameRole = cand.filter((c) => effectiveRole(c.el) === s.role);
        // Among equal-text matches pick the most likely PRIMARY action. h3yun
        // renders the real export button as <div class="button"> in the modal
        // footer, but a same-named dropdown trigger (ant-dropdown-trigger) also
        // exists in the header tabs. Score: modal copy first, .button/primary
        // action bonus, dropdown/tab/trigger penalty; tie-break by DOM order
        // (footer actions appear last).
        const pick = (list) => {
          if (!list || !list.length) return null;
          const score = (c) => {
            const el = c.el;
            const cls = (el.getAttribute && el.getAttribute("class") || "").toLowerCase();
            let s = 0;
            if (inVisibleModal(el)) s += 100;
            if (/\b(button|btn|ant-btn|ant-btn-primary|el-button)\b/.test(cls)) s += 20;
            if (/\b(dropdown|trigger|nav|tab)\b/.test(cls)) s -= 30;
            return s;
          };
          let best = list[0];
          let bestI = 0, bestS = score(best);
          for (let i = 1; i < list.length; i++) {
            const s = score(list[i]);
            if (s > bestS || (s === bestS && i > bestI)) { best = list[i]; bestI = i; bestS = s; }
          }
          return best.el;
        };
        // 1) exact match (most stable)
        found = pick(sameRole.filter((c) => name(c.el) === s.name));
        // 2) normalized match (drops decorative caret tokens / dynamic "(n)" badges / whitespace)
        if (!found) found = pick(sameRole.filter((c) => norm(name(c.el)) === norm(s.name)));
        // 3) phrase-contains fallback (handles badge drift, e.g. "销售管理 (5)" -> "销售管理")
        if (!found) {
          const phrase = norm(s.name).split(/\s+/).filter(Boolean).pop();
          if (phrase) found = pick(sameRole.filter((c) => name(c.el) && name(c.el).includes(phrase)));
        }
      }
      if (found && visible(found) && effectiveRole(found)) return found;
    }
    return null;
  };

  const findByName = (nameQuery) => {
    const cand = [];
    collectCandidates(document, "", cand);
    return cand.filter((c) => name(c.el) === nameQuery && visible(c.el)).map((c) => c.el);
  };

  // Modal/drawer/popup visibility counter — the high-precision signal behind
  // click_effect's "modal opened" verdict. Counts semantic dialog containers
  // plus class-name matches (ant-modal / el-dialog / *-drawer / *-popup ...).
  // Checked BEFORE vs AFTER a click: an increase means the click opened an
  // overlay, even when the element count barely moved (small export dialog
  // replaces a closed dropdown 1:1).
  const MODAL_SEL =
    '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog,' +
    '[class*="modal" i],[class*="dialog" i],[class*="drawer" i],[class*="popup" i]';
  // Is the element inside a VISIBLE modal/overlay container? Tie-breaker for
  // locator resolution: when identical labels exist (弹窗里的"导出" vs 遮罩下
  // 旧页面的"导出"), the modal copy is the one the user can actually interact
  // with. (Covered elements are already pruned by isCovered; this covers the
  // case where both copies pass the hit test, e.g. no full-screen mask.)
  const inVisibleModal = (el) => {
    try {
      const m = el.closest && el.closest(MODAL_SEL);
      return !!(m && visible(m));
    } catch {
      return false;
    }
  };
  const countModals = (doc) => {
    try {
      const d = doc && doc.nodeType === 9 ? doc : document;
      return Array.from(d.querySelectorAll(MODAL_SEL)).filter((e) => visible(e)).length;
    } catch {
      return 0;
    }
  };
  // Uncapped rendered-text length — state.text is viewport-scoped and capped
  // at 6000 chars, so on long pages before/after are both 6000 and the length
  // signal is dead. innerText gives the true rendered length both sides.
  const bodyTextLen = () => {
    try {
      return ((document.body && document.body.innerText) || "").length;
    } catch {
      return 0;
    }
  };

  // Vocabulary reconciliation is the JUDGMENT layer's job: jev/LLM pick the
  // real on-page element ("用户评价") and background.js stamps that resolved
  // label into the spec's `text` field (step.resolvedLabel). We never re-match
  // the literal goal noun here — no inline synonym table.

  const evaluateSpec = (spec) => {
    const textOf = (el) => (el.value != null ? String(el.value) : el.innerText || el.textContent || "");
    const checks = (spec.verification || []).map((c) => {
      if (c.type === "url_matches") {
        let ok = false;
        try { ok = new RegExp(c.regex).test(location.href); } catch { ok = false; }
        return { type: c.type, ok, detail: ok ? "" : `url ${location.href} !~ ${c.regex}` };
      }
      if (c.type === "text_contains") {
        const body = (document.body && (document.body.innerText || document.body.textContent)) || "";
        const ok = body.includes(c.text);
        return { type: c.type, ok, detail: ok ? "" : `text "${c.text}" not found` };
      }
      // Any visible input/textarea whose current VALUE contains the text.
      // Much stronger than text_contains for fill/search steps: the page body
      // always contains distractor words (Baidu suggestions etc.).
      if (c.type === "input_value") {
        // Scan real inputs AND contenteditable fields (rich-text boxes, comment
        // editors, Notion-like surfaces have no .value — verify their textContent).
        // isContentEditable is the browser signal; getAttribute guards runtimes
        // (e.g. jsdom) that don't reflect the property.
        const fields = Array.from(
          document.querySelectorAll("input, textarea, [contenteditable='true']")
        ).filter((el) => {
          if (!visible(el)) return false;
          const ce = el.isContentEditable || el.getAttribute("contenteditable") === "true";
          const v = ce ? (el.textContent || "") : el.value || "";
          return String(v).includes(c.text);
        });
        const ok = fields.length > 0;
        return {
          type: c.type, ok,
          detail: ok ? "" : `no field holds "${c.text}"`,
        };
      }
      // URL contains the text, raw or percent-encoded (e.g. /s?wd=%E6%8A%95...).
      if (c.type === "url_contains") {
        let enc = c.text;
        try { enc = encodeURIComponent(c.text); } catch { /* keep raw */ }
        const ok = location.href.includes(c.text) || location.href.includes(enc);
        return { type: c.type, ok, detail: ok ? "" : `url ${location.href} lacks "${c.text}"` };
      }
      // The page navigated away from the pre-action URL (hash ignored). Used
      // to verify click steps on search/submit buttons where the target is a
      // paraphrase that can never match page text.
      if (c.type === "url_changed") {
        const norm = (u) => String(u || "").split("#")[0];
        const ok = norm(location.href) !== norm(c.from);
        return { type: c.type, ok, detail: ok ? "" : `url unchanged: ${location.href}` };
      }
      // Click landed = the page moved away from the pre-action URL (same-tab
      // navigation or this check runs on a target=_blank spawned tab, whose
      // URL differs from `from` by definition) OR the target text appears in
      // the body. One passing signal is enough — text alone is unreliable on
      // SPA/iframe pages and meaningless when the click opens a new page.
      if (c.type === "click_effect") {
        const norm = (u) => String(u || "").split("#")[0];
        const urlChanged = !!c.from && norm(location.href) !== norm(c.from);
        const body = (document.body && (document.body.innerText || document.body.textContent)) || "";
        const textOk = c.text ? body.includes(c.text) : false;
        // Third signal: the DOM visibly changed vs. the pre-action fingerprint.
        // Fourth signal: a modal/drawer/popup APPEARED (count increased).
        // Together they cover clicks whose only effect is opening a modal —
        // the URL stays, the clicked dropdown's label disappears (导出全部数据
        // -> 导出弹窗) and the net element delta can be as small as zero.
        // Fingerprints are apples-to-apples per frame: candCount is the RAW
        // collectCandidates length (before.actions also contains scroll/wait,
        // select options and "Open X" duplicates, so its baseline is skewed),
        // and bodyTextLen is the uncapped rendered text length (state.text is
        // viewport-scoped and capped at 6000, dead on long pages).
        let domChanged = false;
        let modalOpened = false;
        let dbg = "";
        if (c.before) {
          try {
            const cand = [];
            collectCandidates(document, "", cand);
            const baseCount = Number.isFinite(c.before.candCount)
              ? c.before.candCount
              : Number(c.before.actions || 0);
            const baseLen = Number.isFinite(c.before.bodyTextLen)
              ? c.before.bodyTextLen
              : Number(c.before.textLen || 0);
            const countDiff = Math.abs(cand.length - baseCount);
            const lenDiff = Math.abs(body.length - baseLen);
            domChanged = countDiff >= 3 || lenDiff > 40;
            const modalsNow = countModals(document);
            // Either direction counts: increase = the click OPENED an overlay,
            // decrease = the click closed/submitted one (导出弹窗内点"导出"
            // closes the dialog and starts the download — no URL/text change,
            // and the element count may only wobble slightly).
            if (Number.isFinite(c.before.dialogs)) modalOpened = modalsNow !== c.before.dialogs;
            dbg = `cand ${cand.length} vs ${baseCount} (d${countDiff}), len ${body.length} vs ${baseLen} (d${lenDiff}), modals ${c.before.dialogs} -> ${modalsNow}`;
          } catch { /* keep false */ }
        }
        const ok = urlChanged || textOk || domChanged || modalOpened;
        return {
          type: c.type, ok,
          detail: ok
            ? dbg
            : `url unchanged (${location.href}), text "${c.text || ""}" not found, dom unchanged${dbg ? " [" + dbg + "]" : ""}`,
        };
      }
      if (c.type === "element_present") {
        const els = findByName(c.name);
        const ok = els.length > 0;
        return { type: c.type, ok, detail: ok ? "" : `element "${c.name}" not present` };
      }
      if (c.type === "field_value") {
        const els = findByName(c.name);
        const ok = els.some((e) => textOf(e).trim() === String(c.equals));
        return { type: c.type, ok, detail: ok ? "" : `field "${c.name}" value != "${c.equals}"` };
      }
      return { type: c.type || "?", ok: false, detail: "unknown" };
    });
    return { passed: checks.every((c) => c.ok), checks };
  };

  const run = () => {
    const candidates = [];
    collectCandidates(document, "", candidates);
    const actions = [];
    for (const { el, scope } of candidates) {
      if (!safe(el) || !visible(el)) continue;
      // Keep DISABLED controls in the snapshot (flagged, not dropped): the
      // export dialog's 导出 button is disabled until a field is ticked, and
      // its silent absence made "点击 导出" phrase-match the 导出数据/导出记录
      // tabs instead. Deciders see the marker; execution refuses with a clear
      // reason instead of a silent no-op click.
      const disabled = el.matches(":disabled") || !!el.closest("[aria-disabled='true']");
      const r = el.getBoundingClientRect();
      const rname = effectiveRole(el);
      const cat = classifyElement(el);
      // Keep anything whose rect INTERSECTS the viewport — a center-point-only
      // check silently dropped dialog footer buttons that sat on/below the
      // fold line (pointOf scrollIntoView-s them before clicking).
      if (
        !rname || r.width <= 0 || r.height <= 0 ||
        r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth
      ) continue;
      if (rname === "gridcell" && el.querySelector("button,[role='button']")) continue;
      const base = {
        node: identity(el),
        role: rname,
        label:
          !el.readOnly &&
          el.getAttribute("aria-readonly") !== "true" &&
          (["textbox", "searchbox", "spinbutton"].includes(rname) ||
            (rname === "combobox" && ["INPUT", "TEXTAREA"].includes(el.tagName)) ||
            el.isContentEditable)
            ? fieldLabel(el)
            : name(el) || rname,
        scope,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        locator: locatorOf(el),
        category: cat ? cat.category : null,
        conf: cat ? cat.conf : null,
        attrs: (() => {
          const a = {};
          for (const k of ["id", "name", "type", "aria-label", "data-testid", "placeholder", "alt", "href", "value"]) {
            const v = el.getAttribute ? el.getAttribute(k) : null;
            if (v != null) a[k] = v;
          }
          return a;
        })(),
      };
      if (disabled) base.disabled = true;
      for (const key of ["checked", "selected", "expanded"]) {
        const value = el.getAttribute("aria-" + key);
        if (value !== null) base[key] = value;
      }
      if (["checkbox", "radio"].includes(el.type)) base.checked = String(el.checked);
      if (el.tagName === "SELECT") {
        for (const o of el.options) {
          if (!o.selected && !o.disabled && !o.closest("optgroup[disabled]")) {
            actions.push({
              ...base, kind: "select", value: o.value,
              current_value: [...el.selectedOptions].map((o) => o.label).join(", "),
              label: base.label + " → " + o.label,
            });
          }
        }
      } else {
        const isDateType = ["date", "datetime-local", "month", "week", "time"].includes(el.type);
        const editable =
          !el.readOnly &&
          el.getAttribute("aria-readonly") !== "true" &&
          (["textbox", "searchbox", "spinbutton"].includes(rname) ||
            (rname === "combobox" && ["INPUT", "TEXTAREA"].includes(el.tagName)));
        const value =
          "value" in el
            ? String(el.value)
            : el.isContentEditable || rname === "combobox"
              ? el.innerText.trim()
              : "";
        if (isDateType) {
          // 日期/时间选择器：用 setDate 动词（执行层走 CDP 打开日历并点选），
          // 同时保留 click 孪生以支持「点击打开日历」式步骤。
          actions.push({ ...base, kind: "setDate", value, label: "设置 " + base.label });
          actions.push({ ...base, kind: "click", value, label: "Open " + base.label });
        } else {
          actions.push({ ...base, kind: editable ? "fill" : "click", value });
          if (editable) actions.push({ ...base, kind: "click", value, label: "Open " + base.label });
        }
      }
    }
    const words = [];
    collectText(document, words, 6000, 0);
    const text = words.join("\n").slice(0, 6000);
    const height = document.documentElement.scrollHeight;
    actions.forEach((a, i) => (a.id = "e" + (i + 1)));
    if (scrollY + innerHeight < height - 2) actions.push({ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 });
    if (scrollY > 0) actions.push({ id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -560 });
    actions.push({ id: "wait", kind: "wait", label: "Wait for the page to update" });
    return {
      url: location.href,
      title: document.title,
      w: innerWidth,
      h: innerHeight,
      text,
      // Pre-action click_effect fingerprints (per frame, apples-to-apples):
      // raw candidate count (no scroll/wait/select-option/"Open X" inflation),
      // uncapped rendered text length, and visible modal/overlay count.
      candCount: candidates.length,
      bodyTextLen: bodyTextLen(),
      dialogs: countModals(document),
      scroll: { y: scrollY, height },
      actions,
      omitted_actions: Math.max(0, actions.length - 250),
    };
  };

  if (typeof globalThis !== "undefined") {
    globalThis.__jevSnapshotExt = { run, collectCandidates, collectText, locatorOf, resolve, evaluateSpec, inVisibleModal };
  }
})();
