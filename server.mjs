// Visual dashboard backend for JEV Web Control.
//
// A small, dependency-free Node server (Node 22: global WebSocket + fetch) that
// drives a PERSISTENT headless Chrome via CDP and exposes a JSON API consumed by
// the single-page frontend in public/index.html.
//
//   node server.mjs            -> http://localhost:8787
//   PORT=9000 node server.mjs  -> override the HTTP port
//
// The same Chrome tab is reused across requests so that /api/verify and /api/act
// operate on the page the user is currently looking at (no reload between steps).

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { launchChrome, DESKTOP_UA } from "./scripts/live_cdp.mjs";

const HTTP_PORT = Number(process.env.PORT) || 8787;
const CHROME_PORT = Number(process.env.CHROME_PORT) || 9344;

const SNAP = readFileSync(
  new URL("./scripts/snapshot_extended.js", import.meta.url),
  "utf8"
);

// In-memory mirror of the most recent snapshot (lite form). Used by /api/decide
// so the user does not have to re-send the whole action list on every request.
let lastState = { url: "", title: "", actions: [] };

/* ----------------------------- Chrome lifecycle ---------------------------- */

let chrome = null;

async function ensureChrome() {
  if (chrome) {
    try {
      const r = await fetch(`http://127.0.0.1:${chrome.port}/json/version`);
      if (r.ok) return chrome;
    } catch {
      /* stale handle, respawn below */
    }
    chrome = null;
  }
  chrome = await launchChrome({ port: CHROME_PORT, userAgent: DESKTOP_UA });
  return chrome;
}

// Open a CDP websocket to the (single) page target, optionally navigate + wait,
// run `fn(send)`, then close. Returns whatever fn resolves to.
async function withPage(fn, { navigate = null, waitMs = 6000 } = {}) {
  const { port } = await ensureChrome();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === "page") || list[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(e);
  });

  let msgId = 0;
  const pending = new Map();
  let loadFired = false;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    } else if (m.method === "Page.loadEventFired") {
      loadFired = true;
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  try {
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setAutomationOverride", { enabled: false });
    if (navigate) {
      await send("Page.navigate", { url: navigate });
      const start = Date.now();
      while (!loadFired && Date.now() - start < waitMs) await sleep(200);
      await sleep(waitMs); // settle SPA / lazy content
    }
    return await fn(send);
  } finally {
    ws.close();
  }
}

/* ------------------------------- Core capture ------------------------------ */

// Navigate (when url given) then inject snapshot + capture a viewport screenshot.
async function capture({ url = null, waitMs = 6000 } = {}) {
  const snapExpr = SNAP + "\n;JSON.stringify(globalThis.__jevSnapshotExt.run())";
  const result = await withPage(async (send) => {
    const out = await send("Runtime.evaluate", {
      expression: snapExpr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (out.exceptionDetails) {
      throw new Error(
        "page script threw: " +
          JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails)
      );
    }
    const state = JSON.parse(out.result.value);
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    return { state, screenshot: shot.data };
  }, { navigate: url, waitMs });
  return result;
}

function toLite(raw) {
  const actions = (raw.actions || []).map((a) => ({
    id: a.id,
    role: a.role,
    label: a.label,
    scope: a.scope || "",
    kind: a.kind,
    value: a.value,
    rect: a.rect,
    locator: a.locator,
    attrs: a.attrs || {},
  }));
  return {
    url: raw.url,
    title: raw.title,
    w: raw.w,
    h: raw.h,
    scroll: raw.scroll,
    actions,
  };
}

/* --------------------------------- Actions --------------------------------- */

async function act(actionId) {
  const raw = String(actionId);
  const idStr = raw.startsWith("e") ? raw : "e" + raw;
  const expr = `(() => {
    const s = globalThis.__jevSnapshotExt.run();
    const a = s.actions.find(x => x.id === ${JSON.stringify(idStr)});
    if (!a) return { ok: false, reason: "action not found" };
    const el = window.__jevFast.nodes.get(a.node);
    if (!el || !el.isConnected) return { ok: false, reason: "element stale" };
    try {
      if (a.kind === "select") {
        el.value = a.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (a.kind === "fill") {
        if (el.isContentEditable || el.tagName === "TEXTAREA") {
          el.focus();
          el.textContent = a.value || "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(el, a.value || "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else {
        el.click();
      }
      return { ok: true, kind: a.kind, url: location.href };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  })()`;

  const res = await withPage(async (send) => {
    const out = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (out.exceptionDetails) {
      throw new Error(
        "act failed: " +
          JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails)
      );
    }
    return out.result.value;
  });
  // refresh the snapshot so the UI can show the resulting page state
  const fresh = await capture({});
  const lite = toLite(fresh.state);
  lastState = lite;
  return { result: res, ...lite, screenshot: fresh.screenshot };
}

/* ------------------------------- Mock decision ----------------------------- */

// Keyword-overlap decision that mirrors scripts/decide.py's mock provider, but
// in JS so the dashboard stays single-language. The policy safety layer (sensitive
// words) forces HITL just like policy.py would.
function decide(goal, lite) {
  const g = (goal || "").toLowerCase();
  const tokens = g
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let best = null;
  let bestScore = 0;
  for (const a of lite.actions) {
    if (a.kind === "scroll" || a.kind === "wait") continue;
    const hay = (
      a.label +
      " " +
      a.role +
      " " +
      (a.attrs ? Object.values(a.attrs).join(" ") : "")
    ).toLowerCase();
    let score = 0;
    for (const t of tokens) if (t && hay.includes(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  const sensitive =
    /删除|支付|转账|危险|购买|下单|登出|退出登录|delete|pay|transfer|purchase|checkout|logout|submit order/i.test(
      goal || ""
    );
  const needsHuman = !best || bestScore === 0 || sensitive;
  const confidence = best ? Math.min(0.98, 0.35 + bestScore * 0.18) : 0.0;
  return {
    goal,
    action: best
      ? { id: best.id, label: best.label, role: best.role, scope: best.scope, kind: best.kind }
      : null,
    confidence: +confidence.toFixed(2),
    needsHuman,
    rationale: bestScore
      ? `标签/属性命中 ${bestScore} 个关键词`
      : best
        ? "命中但置信度低"
        : "未命中任何候选元素，建议人工确认",
  };
}

/* --------------------------------- HTTP layer ------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function serveFile(res, rel, type) {
  try {
    const data = readFileSync(new URL("./" + rel, import.meta.url));
    res.writeHead(200, { "content-type": type });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  res.setHeader("content-type", "application/json; charset=utf-8");

  if (path === "/api/observe" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.url) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "missing url" }));
      return;
    }
    const raw = await capture({ url: body.url, waitMs: body.waitMs || 6000 });
    const lite = toLite(raw.state);
    lastState = lite;
    res.end(JSON.stringify({ ...lite, screenshot: raw.screenshot }));
    return;
  }

  if (path === "/api/snapshot" && req.method === "POST") {
    const raw = await capture({});
    const lite = toLite(raw.state);
    lastState = lite;
    res.end(JSON.stringify({ ...lite, screenshot: raw.screenshot }));
    return;
  }

  if (path === "/api/verify" && req.method === "POST") {
    const body = await readBody(req);
    const expr = `globalThis.__jevSnapshotExt.evaluateSpec(${JSON.stringify(body.spec || {})})`;
    const out = await withPage(async (send) => {
      const r = await send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      }
      return r.result.value;
    });
    res.end(JSON.stringify(out));
    return;
  }

  if (path === "/api/act" && req.method === "POST") {
    const body = await readBody(req);
    const out = await act(body.actionId);
    res.end(JSON.stringify(out));
    return;
  }

  if (path === "/api/decide" && req.method === "POST") {
    const body = await readBody(req);
    res.end(JSON.stringify(decide(body.goal, lastState)));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "unknown endpoint" }));
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/" || req.url === "/index.html") {
      serveFile(res, "public/index.html", "text/html; charset=utf-8");
      return;
    }
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
  }
});

server.listen(HTTP_PORT, () => {
  console.log(`\n  JEV Web Control  ->  http://localhost:${HTTP_PORT}\n`);
});

process.on("exit", () => {
  if (chrome && chrome.proc) {
    try {
      chrome.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
});
