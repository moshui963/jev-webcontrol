/*
 * snapshot_extended.js — M1 perception extension for JEV Web Control.
 *
 * Extends jev-ultrafast's snapshot.js so candidate element collection penetrates:
 *   (a) open shadow DOM roots (Salesforce Lightning, Lit/Ionic components, ...)
 *   (b) same-origin <iframe> documents (recursed from the parent JS context)
 * Cross-origin iframes are collected by the Python harness, which runs this
 * snapshot once per CDP execution context and merges the results (see harness.py).
 *
 * Injection contract (unchanged from jev): the whole file is an IIFE that returns
 * the page-state object. The harness does `const state = <this file text>; ...` and
 * reads state.marker / state.actions / state.page_key / state.guards.
 *
 * For tooling/tests it also exposes (on globalThis):
 *   __jevSnapshotExt.run              -> () => page-state object (re-run on current document)
 *   __jevSnapshotExt.collectCandidates-> (rootDoc, scopePrefix, out) => pushes {el,scope}
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
        return true; // older engines without full support => treat as visible
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
    "a[href],button,input,textarea,select,summary,[contenteditable='true']," +
    roles.map((role) => "[role='" + role + "']").join(",");

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

  // Short, human-meaningful, somewhat-stable label for a scope path segment.
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
      return null; // cross-origin -> handled per execution context by the harness
    }
  };

  /*
   * Walk every scope tree reachable from rootDoc and push {el, scope} candidates.
   * scope is a "/" separated path describing how to reach this element:
   *   ""                 -> main document
   *   "iframe[0]/"       -> 1st same-origin iframe
   *   "div#app::shadow/" -> inside an open shadow root of div#app
   * Cross-origin iframes are NOT recursed here (the harness enumerates them).
   */
  const collectCandidates = (rootDoc, scopePrefix, out) => {
    if (!rootDoc) return;
    // Documents need a body; ShadowRoots (nodeType 11) have no .body but still hold elements.
    if (rootDoc.nodeType === 9 && !rootDoc.body) return;
    for (const e of rootDoc.querySelectorAll(selector)) out.push({ el: e, scope: scopePrefix });
    // Penetrate open shadow roots (nesting supported via recursion).
    let shadowHosts = 0;
    for (const e of rootDoc.querySelectorAll("*")) {
      if (inOpenShadow(e)) {
        shadowHosts++;
        collectCandidates(e.shadowRoot, scopePrefix + cssLabel(e) + "::shadow/", out);
      }
    }
    // Recurse same-origin iframes (cross-origin handled by the harness).
    let idx = 0;
    for (const frame of rootDoc.querySelectorAll("iframe")) {
      const child = sameOriginDoc(frame);
      if (child) collectCandidates(child, scopePrefix + "iframe[" + idx++ + "]/", out);
    }
  };

  // Gather visible text across the same scope trees (used by the model for context).
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

  // ---- M2: durable locator synthesis (NEW) ----
  const attrEscape = (v) => String(v).replace(/"/g, '\\"');

  // Stable CSS path from root to el (fragile, last-resort strategy).
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

  // Where does el live? Produces the same scope path used by collectCandidates.
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

  // Synthesize a durable, markup-independent locator for an element.
  // Strategies are ordered best-first; `semantic` survives most DOM churn.
  const locatorOf = (el) => {
    const r = role(el);
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

  // Re-find an element from a locator. Walks scope (iframe/shadow), then tries
  // each strategy in order; returns the live node or null.
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
        found = cand.find((c) => role(c.el) === s.role && name(c.el) === s.name)?.el || null;
      }
      if (found && visible(found) && role(found)) return found;
    }
    return null;
  };

  // ---- M4: declarative verification (NEW) ----
  // Find live elements whose accessible name equals the query (visible only).
  const findByName = (nameQuery) => {
    const cand = [];
    collectCandidates(document, "", cand);
    return cand.filter((c) => name(c.el) === nameQuery && visible(c.el)).map((c) => c.el);
  };

  // Evaluate a declarative verification spec against the LIVE page.
  // spec: { verification: [ {type, ...} ] }  (see design doc §4.3)
  // Returns { passed, checks:[{type, ok, detail}] }.
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
        return { type: c.type, ok, detail: ok ? "" : `text "${c.text}" not found on page` };
      }
      if (c.type === "element_present") {
        const els = findByName(c.name);
        const ok = els.length > 0;
        return { type: c.type, ok, detail: ok ? "" : `element named "${c.name}" not present/visible` };
      }
      if (c.type === "field_value") {
        const els = findByName(c.name);
        const ok = els.some((e) => textOf(e).trim() === String(c.equals));
        return { type: c.type, ok, detail: ok ? "" : `field "${c.name}" value != "${c.equals}"` };
      }
      return { type: c.type || "?", ok: false, detail: "unknown check type" };
    });
    return { passed: checks.every((c) => c.ok), checks };
  };

  // ---- freshness guard (per-document, unchanged semantics from jev) ----
  cache.pageKey = () => [
    performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    [...document.querySelectorAll("input,textarea,select")].filter(safe).map((e) => [
      identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly,
    ]),
  ];
  cache.guard = (e) => {
    if (!e?.isConnected || !visible(e)) return null;
    const scope = e.closest("form,dialog,[role='dialog'],article,li,tr,[role='row']") || e.parentElement;
    return [
      identity(e), role(e), name(e), e.value ?? null, e.checked ?? null, e.selectedIndex ?? null,
      e.readOnly ?? null, e.matches(":disabled"), e.getAttribute("aria-disabled"),
      e.getAttribute("aria-expanded"), e.getAttribute("aria-checked"), e.getAttribute("aria-selected"),
      e.getAttribute("href"), scope?.innerText?.slice(0, 6000) || "",
    ];
  };

  const run = () => {
    const candidates = [];
    collectCandidates(document, "", candidates);

    const actions = [];
    for (const { el, scope } of candidates) {
      if (!safe(el) || !visible(el) || el.matches(":disabled") || el.closest("[aria-disabled='true']")) continue;
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      const rname = role(el);
      if (!rname || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      if (rname === "gridcell" && el.querySelector("button,[role='button']")) continue;

      const base = {
        node: identity(el),
        role: rname,
        label: name(el) || rname,
        scope, // NEW: where this element lives
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        locator: locatorOf(el), // NEW: durable locator synthesized for this element
        attrs: (() => {
          const a = {};
          for (const k of ["id", "name", "type", "aria-label", "data-testid", "placeholder", "alt", "href", "value"]) {
            const v = el.getAttribute ? el.getAttribute(k) : null;
            if (v != null) a[k] = v;
          }
          return a;
        })(),
      };
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
        actions.push({ ...base, kind: editable ? "fill" : "click", value });
        if (editable) actions.push({ ...base, kind: "click", value, label: "Open " + base.label });
      }
    }

    const words = [];
    collectText(document, words, 6000, 0);
    const text = words.join("\n").slice(0, 6000);
    const height = document.documentElement.scrollHeight;

    const page_key = cache.pageKey();
    const guards = {};
    for (const a of actions) if (!(a.node in guards)) guards[a.node] = cache.guard(cache.nodes.get(a.node));

    // Semantic marker (meaning + identity); geometry is always re-resolved before input.
    const semantics = actions.map(({ rect, ...action }) => action);
    const marker = [
      performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
      document.title, text, semantics, page_key[6],
    ];

    const omitted_actions = Math.max(0, actions.length - 250);
    actions.splice(250);
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
      scroll: { y: scrollY, height },
      actions,
      marker,
      page_key,
      guards,
      omitted_actions,
    };
  };

  if (typeof globalThis !== "undefined") {
    globalThis.__jevSnapshotExt = { run, collectCandidates, collectText, locatorOf, resolve, evaluateSpec };
  }
  return run();
})();
