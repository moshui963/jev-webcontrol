// tests/phase5_probe.test.mjs — Phase 5 pure logic (no DOM/browser needed).
import { interpretProbe, routeGroupByHeader } from "../extension/lib/probe.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name); }
}
function eq(name, a, b) { ok(name + " (" + JSON.stringify(a) + ")", JSON.stringify(a) === JSON.stringify(b)); }

console.log("routeGroupByHeader");
{
  const headers = [{ text: "客户", expanded: null }, { text: "销售", expanded: null }, { text: "财务", expanded: null }];
  const r = routeGroupByHeader(headers, "销售管理");
  ok("matches 销售 group", r && r.text === "销售");
}
{
  const headers = [{ text: "系统设置", expanded: null }];
  const r = routeGroupByHeader(headers, "导出合同");
  ok("no meaningful match -> null", r === null);
}
{
  const r = routeGroupByHeader([], "x");
  ok("empty headers -> null", r === null);
}

console.log("interpretProbe");
{
  const data = { hits: [{ text: "销售管理", visible: true, inViewport: true, rect: { x: 100, y: 200, w: 50, h: 20 }, container: null }], headers: [] };
  const r = interpretProbe(data, "销售管理");
  eq("visible in-viewport -> click", [r.mode, r.x, r.y], ["click", 100, 200]);
}
{
  const data = { hits: [{ text: "销售管理", visible: false, inViewport: false, rect: { x: 0, y: 0, w: 0, h: 0 }, container: { label: "销售分组" } }], headers: [] };
  const r = interpretProbe(data, "销售管理");
  eq("hidden behind container -> expand", [r.mode, r.containerLabel], ["expand", "销售分组"]);
}
{
  const data = { hits: [], headers: [{ text: "客户", expanded: null }, { text: "销售", expanded: null }] };
  const r = interpretProbe(data, "销售管理");
  eq("no hit -> route to best header", [r.mode, r.headerText], ["route", "销售"]);
}
{
  const data = { hits: [], headers: [] };
  const r = interpretProbe(data, "销售管理");
  eq("nothing -> none", [r.mode], ["none"]);
}
{
  // visible but OUT of viewport must NOT be treated as a direct click.
  const data = { hits: [{ text: "销售管理", visible: true, inViewport: false, rect: { x: 100, y: 5000, w: 50, h: 20 }, container: null }], headers: [] };
  const r = interpretProbe(data, "销售管理");
  ok("visible-but-offscreen is not a click", r.mode !== "click");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
