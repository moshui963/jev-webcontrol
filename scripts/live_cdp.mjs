// Minimal Chrome DevTools Protocol driver — no external deps.
// Uses Node 22's built-in global WebSocket + fetch.
// Lets us drive the real browser WITHOUT the `browser-harness` package that
// jev-ultrafast depends on (which isn't installed here). This makes M1/M2/M4
// testable against live, messy websites (shadow DOM + iframe heavy, e.g. CSDN).

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";

export const CHROME_BIN =
  process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";

export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Launch headless Chrome with a remote-debugging port (starts on about:blank).
 * Returns the child process + port so the caller can kill it afterwards.
 */
export async function launchChrome({
  port = 9333,
  userAgent,
  userDataDir = "C:/Users/Administrator/AppData/Local/Temp/jev_cdp_profile",
}) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];
  if (userAgent) args.push(`--user-agent=${userAgent}`);
  const proc = spawn(CHROME_BIN, args, { stdio: "ignore" });
  const devtools = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${devtools}/json/version`);
      if (r.ok) return { proc, port };
    } catch {
      /* not ready yet */
    }
    await sleep(300);
  }
  proc.kill("SIGKILL");
  throw new Error("Chrome DevTools endpoint did not come up");
}

/**
 * Attach to the first page target, then:
 *   1. disable the `navigator.webdriver` automation flag (anti-bot WAF bypass)
 *   2. optionally spoof a desktop User-Agent
 *   3. navigate to `url`, wait for load
 *   4. evaluate `expression` and return its value (returnByValue)
 */
export async function evaluateOnPage({
  port,
  url,
  expression,
  waitMs = 6000,
}) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === "page") || list[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  let msgId = 0;
  const pending = new Map();
  const loadFired = { value: false };

  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(e);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    } else if (m.method === "Page.loadEventFired") {
      loadFired.value = true;
    }
  };

  await send("Runtime.enable");
  await send("Page.enable");
  // anti-bot: hide the automation flag
  await send("Emulation.setAutomationOverride", { enabled: false });
  await send("Page.navigate", { url });
  const start = Date.now();
  while (!loadFired.value && Date.now() - start < waitMs) await sleep(200);
  await sleep(waitMs); // extra settle for SPA / lazy content

  const out = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  ws.close();
  if (out?.exceptionDetails) {
    throw new Error(
      "page script threw: " + JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails)
    );
  }
  // `out` is already the CDP `result` object: { result: {type,value}, exceptionDetails }
  return out?.result?.value;
}

/**
 * Convenience: inject our snapshot_extended.js into a live page and return
 * the structured state (actions with scope + durable locator, etc.).
 */
export async function observeLive(url, { waitMs = 6000, userAgent = DESKTOP_UA } = {}) {
  const snap = readFileSync(
    new URL("../scripts/snapshot_extended.js", import.meta.url),
    "utf8"
  );
  const { proc, port } = await launchChrome({ port: 9333, userAgent });
  try {
    const expr = `${snap}\n;JSON.stringify(globalThis.__jevSnapshotExt.run())`;
    const stateStr = await evaluateOnPage({
      port,
      url,
      expression: expr,
      userAgent,
      waitMs,
    });
    return typeof stateStr === "string" ? JSON.parse(stateStr) : stateStr;
  } finally {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}
