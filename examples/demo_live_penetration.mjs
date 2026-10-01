// Live M1 penetration test on a REAL browser: serves a local page that has an
// open shadow-root button + a same-origin iframe button, then drives real Chrome
// with our snapshot_extended.js. Proves the shadow/iframe penetration works in a
// real browser (not just jsdom). Read the scope column.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { observeLive } from "../scripts/live_cdp.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // project root (jev-webcontrol)
const MIME = { ".html": "text/html", ".js": "text/javascript" };

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  if (p === "" || p === "examples/shadow_iframe_demo.html") p = "examples/shadow_iframe_demo.html";
  const file = join(ROOT, p);
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise((r) => server.listen(8123, r));
const url = "http://127.0.0.1:8123/examples/shadow_iframe_demo.html";
console.log(`\n=== 真机穿透测试 M1: ${url} ===\n`);

const state = await observeLive(url, { waitMs: 4000 });
const all = state.actions || [];
const acts = all.filter((a) => a.kind !== "wait" && a.kind !== "scroll");

console.log("URL:", state.url, "| TITLE:", state.title);
console.log("TEXT:", String(state.text || "").slice(0, 80));
console.log("原始候选(含 wait):", all.length, "| 过滤后:", acts.length, "\n");
for (const a of acts) {
  const scope = a.scope || "(主文档)";
  const loc = a.locator
    ? a.locator.strategies.map((s) => `${s.type}=${s.role || s.selector || s.name || ""}`).join(" | ")
    : "-";
  console.log(`  ${String(a.id).padEnd(4)} | ${scope.padEnd(26)} | ${String(a.label).padEnd(16)} | ${loc}`);
}
const scopes = new Set(acts.map((a) => a.scope || "(主文档)"));
console.log(
  `\n穿透到的独立作用域数: ${scopes.size} →`,
  [...scopes].map((s) => (s || "(主文档)")).join(" , ")
);
server.close();
