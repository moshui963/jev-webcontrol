// background.js — extension brain: flow state, message router, settle detection,
// sequential direct execution engine (one real tab, verify each step, local
// exploration + fresh re-judge on failure), real model providers
// (jev/TypeSafe + DeepSeek), MD packaging.
import { decideTopK, mockDecide } from "./lib/decide.js";
import { targetOf, goalAligned, foldText, revealSkipCandidate } from "./lib/calibrate.js";
import { defaultSpecFor, fracOf, summarize } from "./lib/verify.js";
import { planFromNL, fieldValue, groundVision, needsRoute, routeJudge, planExhaustedAction, routeShouldSkip, goalComplete } from "./lib/llm.js";
import { decideExecutor } from "./lib/probe-policy.js";
import { parseGoal, inferSuccess } from "./lib/goal.js";
import { browserUseFallback } from "./lib/browseruse.js";
import { runProbe, runProbeSweep, captureScreenshot, getViewport, interpretProbe } from "./lib/probe.js";
import { pageSig, goalSuccessFired, checkStuck, stuckQuestion } from "./lib/governance.js";
import { replan } from "./lib/replan.js";
import { dispatchAction, buildKeyEvents, coverageOk } from "./lib/actions/registry.js";

// ---------- persisted config ----------
const DEFAULT_CONFIG = {
  typesafeKey: "",
  typesafeModel: "decision-model-preview",
  typesafeEndpoint: "https://api.typesafe.ai/v1/systemone",
  jevAdapter: "typesafe", // "typesafe" | "openai"
  deepseekKey: "",
  deepseekBase: "https://api.deepseek.com/v1",
  deepseekModel: "deepseek-chat",
  vision: false,
  visionKey: "", // Phase 5-B: OpenAI-compatible vision model for screenshot grounding
  visionBase: "",
  visionModel: "",
  browserUseUrl: "", // optional: delegate hard steps to a real browser-use backend
  routeOn: true, // 功能配置：LLM 路线裁判开关（Route 层）
  routeTopBar: 0.6, // 功能配置：jev 置信低于该值才升级 LLM 判路线
  probeOn: true, // 功能配置：DOM 探针开关
  probeLockBar: 0.6, // 功能配置：jev 置信 ≥ 该值则探针不接管（越大越信任 jev）
  // v0.4.31: 懒加载滚动扫描策略（设置页可调）
  sweepStrategy: "onDemand", // onDemand(仅探针miss才扫,推荐) | everyStep | random | lastStep | never
  sweepMaxSteps: 6, // 最大滚动屏数（"滑动几下"）
  sweepStepRatio: 0.8, // 每次滚动占视口比例
  // v0.5: 模型渠道（渠道列表 UI）——每个渠道可自定义名称、维护一组模型
  // （含能力标签），并可与引擎主模型同步。channelNames 是显示名覆盖，
  // jevModels/dsModels/visModels 是各渠道的模型清单 [{name, caps:[...]}]。
  channelNames: {}, // { jev?: "…", ds?: "…", vis?: "…", bu?: "…" }
  jevModels: [], // JEV 决策引擎渠道的模型清单
  dsModels: [], // DeepSeek 路线裁判渠道的模型清单
  visModels: [], // Vision 视觉兜底渠道的模型清单
};
const config = { ...DEFAULT_CONFIG };
chrome.storage.local.get("config").then((d) => Object.assign(config, d.config || {})).catch(() => {});

// ---------- MV3 worker-lifecycle persistence ----------
// The MV3 service worker is killed after ~30s idle and restarted on the next
// message — with a fresh, empty `state`. Without persistence the user's plan
// silently vanishes between "生成计划" and "启动探索" (explorer then fails with
// "请先在 Agent 里描述自动化步骤"). Persist the durable parts to
// chrome.storage.session (survives worker restarts, cleared on browser exit).
const PERSIST_KEYS = [
  "plan", "stepIndex", "history", "stepSnaps", "lastPlanSource",
  "workingTabId", "lastState", "routes", "routesMeta", "lastProvider", "lastErrors",
  "runLog",
];
// The whole run (incl. confirm-mode pause state) must survive worker restarts —
// otherwise a worker kill between two confirm cards silently drops `confirmMode`
// and the engine stops pausing for the user (v0.3.28). Only durable fields are
// persisted; transient `best`/`routes` live elsewhere.
function persistState() {
  const snap = {};
  for (const k of PERSIST_KEYS) snap[k] = state[k];
  if (state.run) {
    snap.run = {
      running: state.run.running,
      mode: state.run.mode,
      width: state.run.width,
      round: state.run.round,
      stepIndex: state.run.stepIndex,
      provider: state.run.provider,
      note: state.run.note,
      confirmMode: !!state.run.confirmMode,
      waiting: state.run.waiting || null,
      resumeIdx: state.run.resumeIdx ?? null,
      trail: state.run.trail || [],
      failedSigs: state.run.failedSigs || [],
    };
  }
  chrome.storage.session.set({ appState: snap }).catch(() => {});
}
let runResumeScheduled = false;
const stateReady = chrome.storage.session
  .get("appState")
  .then((d) => {
    const saved = d?.appState;
    if (saved) {
      for (const k of PERSIST_KEYS) if (saved[k] !== undefined) state[k] = saved[k];
      if (saved.run) state.run = saved.run;
    }
  })
  // After a worker restart, resume an in-flight run: re-enter runLoop if it was
  // mid-execution (not paused for confirm) so the exploration continues; if it
  // was paused on a confirm card, stay paused — the panel will show the card and
  // RUN_APPROVE re-enters the loop.
  .then(() => {
    if (state.run?.running && !state.run.waiting && !runResumeScheduled) {
      runResumeScheduled = true;
      runLoop().catch((e) => {
        if (state.run) { state.run.running = false; state.run.note = "重启续跑异常: " + (e?.message || e); }
      });
    }
  })
  .catch(() => {});

const state = {
  workingTabId: null,
  plan: null, // { steps:[{intent,verb,target,url,value}], entryUrl }
  stepIndex: 0,
  lastState: null,
  routes: [],
  history: [], // manual mode: {intent, action, verify}
  model: { pref: "auto" }, // auto | jev | deepseek | mock
  user: { name: "", tenant: "" },
  run: null, // { running, mode, width, round, stepIndex, provider, note, best }
  stepSnaps: {}, // per-step full snapshots: stepIndex -> {url,title,actions[]}
  routesMeta: null, // { provider, errors, snapCount, url } for the routes panel
  lastPlanSource: "", // 计划来源；"" 表示尚未生成（已移除 regex 兜底，必为 deepseek 或失败原因）
  // Goal-driven (agentic) mode: a one-line objective instead of a step list.
  goal: null, // { goal, subGoals:[{noun,kind}], successCriteria, steps }
  goalMode: false, // when true, runStep lets the Controller deviate/explore
  subGoalIdx: 0, // index into goal.subGoals the current step is chasing
  controllerHistory: [], // last N controller actions for self-consistency
  runLog: [], // 运行日志流：{ts, tag, text}，面板「运行日志」原样展示
  runLogRev: 0, // 每追加一条 +1，面板据此判断是否需要重绘
};

// ---------- 运行日志（原始日志流） ----------
// 设计原则：不做任何渲染加工，一行一条，格式 `HH:MM:SS [标签] 文本`。
// 标签约定：用户 / LLM / JEV / 执行 / 探针 / 兜底 / 反射 / 系统 / 人工
const RUN_LOG_LIMIT = 800;
function logLine(tag, text) {
  const d = new Date();
  const ts = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  state.runLog = state.runLog || [];
  state.runLog.push({ ts, tag: String(tag || "系统"), text: String(text || "") });
  if (state.runLog.length > RUN_LOG_LIMIT) state.runLog.splice(0, state.runLog.length - RUN_LOG_LIMIT);
  state.runLogRev = (state.runLogRev || 0) + 1;
}
// 多行文本（步骤清单等）按日志缩进排版，便于面板原样阅读。
function logLines(tag, header, lines) {
  logLine(tag, header);
  for (const l of lines || []) logLine(tag, "  " + l);
}
function fmtPlanSteps(steps) {
  return (steps || []).map((s, i) => `${i + 1}. ${s.intent}${s.target ? `（${s.target}）` : ""}`);
}
function fmtCandidates(routes) {
  return (routes || []).map(
    (r, i) => `${i === 0 ? "★" : "·"} ${r.action?.kind} ${r.action?.label || "?"} p${Math.round((r.score || 0) * 100)}%`
  );
}

// Phase 3 — deterministic download detection. The goal success signal "download"
// (导出/下载) cannot be proven by click_effect alone; a download listener flips
// `state.run.downloadFired` the moment the browser actually writes a file, which
// `checkGoalSuccess()` then reads as the authoritative "done" signal.
chrome.downloads?.onCreated.addListener(() => {
  if (state.run?.running) state.run.downloadFired = true;
});

// ---------- tab helpers ----------
// frameId: when given, the message is delivered ONLY to that frame. A plain
// broadcast reaches all frames and the FIRST response wins — on iframe-heavy
// pages (e.g. 淘宝 kiss) a near-empty iframe can answer first and poison the
// snapshot / fail the action.
const sendToTab = (tabId, msg, frameId) =>
  new Promise((resolve) => {
    if (!tabId) return resolve({ ok: false, reason: "no tab" });
    const opts = frameId != null ? { frameId } : undefined;
    chrome.tabs.sendMessage(tabId, msg, opts, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, reason: chrome.runtime.lastError.message });
      resolve(res || { ok: false, reason: "no response" });
    });
  });

function listFrames(tabId) {
  return new Promise((resolve) => {
    if (!chrome.webNavigation?.getAllFrames) return resolve(null);
    chrome.webNavigation.getAllFrames({ tabId }, (frames) =>
      resolve(chrome.runtime.lastError ? null : frames || []));
  });
}

const actionableCount = (s) =>
  (s?.actions || []).filter((a) => a.kind !== "scroll" && a.kind !== "wait").length;

// Observe every frame of the tab and return the RICHEST snapshot (with the
// winning frameId embedded in state). Falls back to a plain broadcast when
// webNavigation is unavailable.
async function observeTab(tabId) {
  const frames = await listFrames(tabId);
  if (!frames || !frames.length) return sendToTab(tabId, { type: "OBSERVE" });
  const targets = frames.filter((f) => f.frameId === 0 || /^https?:/i.test(f.url || ""));
  const results = await Promise.all(
    targets.map((f) =>
      sendToTab(tabId, { type: "OBSERVE" }, f.frameId).then((r) => {
        if (r && r.ok && r.state) {
          r.state.frameId = f.frameId;
          r.state.frameUrl = f.url || "";
          return { ...r, frameId: f.frameId, frameUrl: f.url };
        }
        return null;
      })
    )
  );
  const oks = results.filter(Boolean);
  if (!oks.length) return { ok: false, reason: "各 frame 均未响应观察" };
  oks.sort((a, b) => actionableCount(b.state) - actionableCount(a.state));
  return oks[0];
}

// Evaluate a verify spec in the acting frame AND the top document, keep the
// better result (fill checks live in the acting frame; url checks need the
// top document). With no acting frame (e.g. verifying on a target=_blank
// spawned tab) scan every http frame too — SPA shells (h3yun ERP) render the
// real content inside iframes, and a top-document-only check scores 0 even
// when the click landed perfectly.
async function evaluateTab(tabId, spec, frameId) {
  let targets = frameId != null ? [frameId, 0] : [0];
  if (frameId == null) {
    const frames = await listFrames(tabId);
    for (const f of frames || []) {
      if (f.frameId !== 0 && /^https?:/i.test(f.url || "")) targets.push(f.frameId);
    }
  }
  targets = [...new Set(targets)].slice(0, 12); // sanity cap
  const results = await Promise.all(targets.map((f) => sendToTab(tabId, { type: "EVALUATE", spec }, f)));
  const oks = results.filter((r) => r && r.ok);
  if (!oks.length) return null;
  oks.sort((a, b) => fracOf(b.result) - fracOf(a.result));
  return oks[0];
}

const activeTab = () =>
  new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
  });

const closeTab = (tabId) => {
  try { chrome.tabs.remove(tabId); } catch { /* ignore */ }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pages we are not allowed to inject into (browser internals / web store).
const injectableUrl = (url) =>
  !!url && /^https?:/i.test(url) && !/^https:\/\/chrome\.google\.com\/webstore/i.test(url);

// Ensure a content script is alive in the tab. Auto-injection only covers
// pages loaded *after* the extension was (re)loaded; pre-existing tabs and
// some redirects miss it. Ping first; on silence, inject programmatically
// via chrome.scripting and ping again.
async function ensureContentScript(tabId, tries = 1) {
  if (!tabId) return { ok: false, reason: "no tab" };
  for (let i = 0; i <= tries; i++) {
    const ping = await sendToTab(tabId, { type: "PING" });
    if (ping && ping.ok) return { ok: true };
    if (i < tries) await sleep(400);
  }
  const tab = await new Promise((r) =>
    chrome.tabs.get(tabId, (t) => (chrome.runtime.lastError ? r(null) : r(t)))
  );
  if (!tab) return { ok: false, reason: "标签页不存在（可能已被关闭）" };
  if (!injectableUrl(tab.url || tab.pendingUrl))
    return { ok: false, reason: "该页面不支持注入（浏览器内部页或非 http 页面）: " + (tab.url || "").slice(0, 60) };
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      // ISOLATED world (default): shares the page DOM but keeps chrome.runtime
      // messaging. MAIN world cannot use chrome.* APIs at all.
      files: ["content/snapshot_injected.js", "content/content.js"],
    });
  } catch (e) {
    return { ok: false, reason: "注入 content script 失败: " + (e?.message || e) };
  }
  await sleep(350);
  const ping2 = await sendToTab(tabId, { type: "PING" });
  if (ping2 && ping2.ok) return { ok: true };
  // Last resort: page JS may still be booting; short retry loop.
  for (let i = 0; i < 3; i++) {
    await sleep(700);
    const p = await sendToTab(tabId, { type: "PING" });
    if (p && p.ok) return { ok: true };
  }
  return { ok: false, reason: "注入后 content script 仍无响应（页面可能有 CSP/框架限制）" };
}

async function observeRetry(tabId, tries = 8, delay = 700) {
  // Make sure the tab actually has the content script before hammering it.
  const ensured = await ensureContentScript(tabId);
  if (!ensured.ok) return { ok: false, reason: ensured.reason };
  let lastRes = null;
  for (let i = 0; i < tries; i++) {
    const res = await observeTab(tabId);
    if (res && res.ok) {
      state.lastState = res.state;
      // A half-loaded page yields a shell DOM with very few actionable
      // elements (e.g. only 百度一下/更多 while the search box, nav links and
      // hot-search list have not rendered yet). Treat that as "not ready"
      // and keep polling so the snapshot reflects the finished page.
      const actionable = (res.state?.actions || []).filter((a) => a.kind !== "scroll" && a.kind !== "wait").length;
      if (actionable >= 4 || i === tries - 1) {
        // Outside a run, remember what the CURRENT step's page looked
        // like so the panel's per-step tab has a full snapshot even when the
        // user only observes / single-steps without starting a run.
        if (!state.run?.running) saveStepSnap(state.stepIndex, res.state);
        return res;
      }
      lastRes = res;
    }
    await sleep(delay);
  }
  return lastRes || { ok: false, reason: "content script 未响应（页面可能不支持或未加载完成）" };
}

// Wait for a tab to finish navigating after an action (page reload / new URL),
// plus a quiet period for SPA renders. Resolves via tabs.onUpdated "complete"
// or a timeout fallback (pure SPA/no-navigation case).
function waitForSettle(tabId, timeoutMs = 1800) {
  return new Promise((resolve) => {
    let settled = false;
    let navigating = false; // a real navigation fired (full page load)
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(shortTimer);
      clearTimeout(longTimer);
      setTimeout(resolve, 150); // short quiet period — SPA renders in <150ms
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") navigating = true;
      if (info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    // SPA clicks don't navigate: resolve fast. If a real navigation actually
    // started, give it a longer budget instead of failing the verify on a
    // half-loaded page.
    const shortTimer = setTimeout(() => { if (!navigating) finish(); else longTimer = setTimeout(finish, 6000); }, timeoutMs);
    let longTimer = null;
  });
}

// ---------- planning ----------
async function buildPlan(text) {
  // 计划强制由 LLM（DeepSeek）生成 —— 已移除 regex 兜底。
  // 没有 Key / 处于 mock 模式 / LLM 调用失败，都直接抛错并返回原因，
  // 绝不再用内置规则硬拆步骤。
  if (!config.deepseekKey) {
    const why = "未配置 DeepSeek Key，计划必须由 LLM 生成（请到 设置 → 模型配置 → DeepSeek 路线裁判 填写 Key）";
    state.lastPlanSource = "LLM 解析失败：" + why;
    throw new Error(why);
  }
  if (state.model.pref === "mock") {
    const why = "当前为 mock 模式，计划必须由真实 LLM 生成（请在 Agent 页把模型渠道切换为非 mock）";
    state.lastPlanSource = "LLM 解析失败：" + why;
    throw new Error(why);
  }
  logLine("LLM", "planFromNL 请求：解析自然语言计划（DeepSeek）");
  try {
    const plan = await planFromNL(text, config);
    if (plan && plan.steps && plan.steps.length) {
      state.lastPlanSource = "deepseek";
      logLines("LLM", `计划解析成功（DeepSeek，${plan.steps.length} 步）`, fmtPlanSteps(plan.steps));
      return plan;
    }
    const why = "DeepSeek 未返回有效步骤（返回为空或步骤数为 0）";
    state.lastPlanSource = "LLM 解析失败：" + why;
    throw new Error(why);
  } catch (e) {
    const why = "DeepSeek 调用出错：" + (e && e.message ? e.message : String(e));
    state.lastPlanSource = "LLM 解析失败：" + why;
    logLine("LLM", why);
    throw new Error(why);
  }
}

// ---------- observation / decide ----------
async function observe(tabId) {
  const res = await sendToTab(tabId, { type: "OBSERVE" });
  if (res && res.ok) state.lastState = res.state;
  return res;
}

async function computeRoutes() {
  if (!state.plan || !state.lastState) return [];
  const step = state.plan.steps[state.stepIndex];
  if (!step) return [];
  const decision = await decideTopK(state.lastState, goalFor(step), 3, config, state.model.pref, state.history);
  state.lastProvider = decision.provider;
  state.lastErrors = decision.errors || [];
  state.routes = decision.routes;
  // Remember the context the decision was made on — if the snapshot was a
  // half-loaded shell (few elements), the candidates will be poor and the
  // panel can say so instead of leaving the user guessing.
  state.routesMeta = {
    provider: decision.provider,
    errors: decision.errors || [],
    snapCount: (state.lastState?.actions || []).filter((a) => a.kind !== "scroll" && a.kind !== "wait").length,
    url: state.lastState?.url || "",
  };
  return state.routes;
}

// Resolve the value to type for fill actions. Prefer the plan's explicit
// value, then the step target (e.g. search keyword); LLM only as fallback.
// Never trust action.value — that is the field's current content, not intent.
async function resolveFillValue(step, action) {
  if (step.value) return step.value;
  if (step.target) return step.target;
  if (config.deepseekKey && state.model.pref !== "mock") {
    try {
      return await fieldValue(step.intent, action, state.lastState?.text || "", config);
    } catch { /* fall through */ }
  }
  return "";
}

// Whether the NEXT step is a click on a search/submit button — if so, a fill
// step must NOT auto-submit: the submit would steal the click step's job (and
// on sites like Tmall it opens a NEW tab, leaving the click step stranded on
// the results page with no search button to click).
function nextStepIsSearchClick(steps, idx) {
  const nx = steps && steps[idx + 1];
  if (!nx || nx.verb !== "click") return false;
  return /搜索|查询|检索|search|submit/i.test(nx.intent || "") || /搜索|查询|search|submit/i.test(nx.target || "");
}

// ---------- CDP trusted input ----------
// Synthetic dispatchEvent() clicks carry isTrusted=false, and some SPAs
// (h3yun/氚云) ignore them completely — the page sees the events but its
// handlers never fire. chrome.debugger's Input.dispatchMouseEvent injects
// input at the BROWSER level: identical to a human click (isTrusted=true,
// real hit-testing, pointer events included). Requires the "debugger"
// permission; Chrome shows its "正在调试此浏览器" infobar while attached.
async function cdpClick(tabId, x, y) {
  const dbg = { tabId };
  await chrome.debugger.attach(dbg, "1.3");
  try {
    const send = (method, params) => chrome.debugger.sendCommand(dbg, method, params);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", pointerType: "mouse" });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    return true;
  } finally {
    chrome.debugger.detach(dbg).catch(() => {});
  }
}

// Move the trusted pointer WITHOUT pressing — used to (re)open hover/focus
// dropdown menus that vanish the moment the cursor leaves the trigger. Kept
// separate from cdpClick so a reveal step can hold the menu open across the
// gap between "open" and "click the item inside it".
async function cdpHover(x, y) {
  const dbg = { tabId: state.workingTabId };
  try { await chrome.debugger.attach(dbg, "1.3"); } catch { return; }
  try {
    const send = (m, p) => chrome.debugger.sendCommand(dbg, m, p);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", pointerType: "mouse" });
  } catch { /* ignore */ } finally { chrome.debugger.detach(dbg).catch(() => {}); }
}

// Park the pointer in a neutral corner so any hover/focus menu closes — used
// when a previously-opened transient menu is no longer needed (stale / consumed).
async function releaseHover() { await cdpHover(1, 1); }

// Trusted CDP drag: press at source, interpolate moves to target, release.
// Replaces the old synthetic MouseEvent drag (which SPAs ignored, same trust
// hole click had before moving to CDP).
async function cdpDrag(tabId, from, to) {
  const dbg = { tabId };
  await chrome.debugger.attach(dbg, "1.3");
  try {
    const send = (m, p) => chrome.debugger.sendCommand(dbg, m, p);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none", pointerType: "mouse" });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, pointerType: "mouse" });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, pointerType: "mouse" });
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, pointerType: "mouse" });
    return true;
  } finally {
    chrome.debugger.detach(dbg).catch(() => {});
  }
}

// Trusted CDP typing: focus at (x,y) then dispatch real key events char-by-char.
// Faithful input (isTrusted=true) so SPAs/controlled components accept it; we
// still fall back to content-script value injection in the executor when this
// is unavailable or fails to land.
async function cdpType(tabId, x, y, text) {
  const dbg = { tabId };
  await chrome.debugger.attach(dbg, "1.3");
  try {
    const send = (m, p) => chrome.debugger.sendCommand(dbg, m, p);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", pointerType: "mouse" });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, pointerType: "mouse" });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, pointerType: "mouse" });
    for (const ev of buildKeyEvents(text)) {
      await send("Input.dispatchKeyEvent", { ...ev, modifiers: 0, windowsVirtualKeyCode: ev.text ? ev.text.charCodeAt(0) : 0 });
    }
    return true;
  } finally {
    chrome.debugger.detach(dbg).catch(() => {});
  }
}

// Phase 5: perform a trusted CDP click at a target's center (from the DOM probe
// or vision grounding) and let the page settle. Returns true on success.
async function execProbeClick(x, y) {
  try {
    await cdpClick(state.workingTabId, x, y);
  } catch (e) {
    console.warn("[probe] click failed:", e?.message || e);
    return false;
  }
  await sleep(600);
  return true;
}

// Set by runStep when the PREVIOUS step opened a dropdown menu; consumed by
// execCandidate right before the click so the dependent item is clicked while
// the menu is still open. Null unless a dependent step is actively executing.
let pendingRevealHover = null;

// Build the dependency object the action registry needs. Each method either
// calls a trusted CDP routine or routes a message to the content script.
function actionDeps(tabId, frameId) {
  const pt = async (a) => {
    let r = await sendToTab(tabId, { type: "POINT", action: a }, frameId);
    if (!r || !r.ok) r = await sendToTab(tabId, { type: "POINT", action: a });
    return r && r.ok ? r : { ok: false, reason: (r && r.reason) || "POINT 失败" };
  };
  return {
    point: pt,
    cdpClick: (x, y) => cdpClick(tabId, x, y),
    cdpHover: (x, y) => cdpHover(x, y),
    cdpDrag: (a, b) => cdpDrag(tabId, a, b),
    cdpType: (x, y, t) => cdpType(tabId, x, y, t),
    actInject: async (a) => {
      let r = await sendToTab(tabId, { type: "ACT", action: a }, frameId);
      if (!r || !r.ok) r = await sendToTab(tabId, { type: "ACT", action: a });
      return r;
    },
    readField: async (a) => {
      const r = await sendToTab(tabId, { type: "READ_FIELD", action: a }, frameId);
      return r && r.ok ? (r.value || "") : "";
    },
    isNativeDate: async (a) => {
      const r = await sendToTab(tabId, { type: "IS_NATIVE_DATE", action: a }, frameId);
      return !!(r && r.ok);
    },
    setDateNative: (a, iso) => sendToTab(tabId, { type: "SET_DATE_NATIVE", action: a, iso }, frameId),
    openDatePicker: (a) => sendToTab(tabId, { type: "OPEN_DATE_PICKER", action: a }, frameId),
    resolveDateCell: async (target) => {
      const r = await sendToTab(tabId, { type: "RESOLVE_DATE_CELL", target }, frameId);
      return r && r.ok ? { cx: r.cx, cy: r.cy } : null;
    },
    clickDateNav: (dir) => sendToTab(tabId, { type: "CLICK_DATE_NAV", dir }, frameId),
    sleep,
  };
}

// Perform an action on a tab. All verbs now funnel through the action registry
// (lib/actions/registry.js): click/hover/drag/setDate go through trusted CDP,
// fill/select/check/toggle/scroll go to the content script (with CDP typing as
// the fill fast-path). One entry point, one verb vocabulary — no more scattered
// per-kind switches across the codebase.
async function actOnTab(tabId, frameId, action) {
  if (!action || !action.kind) return { ok: false, reason: "无动作类型" };
  return dispatchAction(action, actionDeps(tabId, frameId));
}

const tabUrl = (tabId) =>
  new Promise((resolve) => {
    if (!tabId) return resolve(null);
    chrome.tabs.get(tabId, (t) => resolve(chrome.runtime.lastError ? null : t?.url || null));
  });

const stripHash = (u) => String(u || "").split("#")[0];

// Undo a WRONG-but-"passing" click (goal-alignment gate) so the next candidate
// runs against the page the step STARTED on, not wherever the wrong click
// landed. Two shapes: the acting tab navigated -> history.back(); the click
// spawned a tab the run followed -> close it and step back. Also drops the
// Pillar-B menu state — the page the menu belonged to is gone.
async function revertTab(baseTabId, preUrl) {
  state.run.openMenu = null;
  await releaseHover();
  if (state.workingTabId !== baseTabId) {
    const drifted = state.workingTabId;
    state.workingTabId = baseTabId;
    closeTab(drifted);
  } else {
    const cur = await tabUrl(baseTabId);
    if (stripHash(cur) !== stripHash(preUrl)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: baseTabId },
          func: () => history.back(),
        });
        await waitForSettle(baseTabId);
      } catch { /* best effort — the fresh re-judge below re-observes anyway */ }
    }
  }
  await observeRetry(state.workingTabId);
}

// Execute one candidate action on a tab, wait for settle, verify. Returns
// { ok, verifyFrac, verifyStr, action, resultTabId, spawned } — action is what
// ACTUALLY ran (value resolved, submit flag set), so history records reality,
// not the raw route. resultTabId is where the page state now lives: the acting
// tab if it navigated, otherwise a NEW tab the click opened (taobao/baidu
// search forms use target=_blank — the acting tab stays put while the results
// open elsewhere; the run must follow that tab, not stay behind).
async function execCandidate(tabId, step, route) {
  const ensured = await ensureContentScript(tabId);
  if (!ensured.ok) return { ok: false, verifyFrac: 0, verifyStr: ensured.reason };
  // Find the frame that actually hosts the actionable content — a broadcast
  // ACT on an iframe-heavy page can be answered (and fail) by a random frame.
  const obs = await observeTab(tabId);
  const frameId = obs?.ok ? obs.frameId : null;
  const beforeUrl = obs?.ok ? obs.state?.url || "" : "";
  const action = { ...route.action };
  // Judgment-layer resolution: jev/LLM committed to THIS real on-page element
  // (e.g. "用户评价" for a goal noun "评论"). Stamp its label so downstream
  // verification/completion match the term the decision layer actually chose —
  // NOT a literal re-match of the goal noun, and no synonym table anywhere.
  // criteria.resolvedValue is set only on a verifying success (below), so goal
  // completion won't fire before the matching step has actually run.
  step.resolvedLabel = action.label;
  // action.value is the field's CURRENT value (e.g. Baidu prefills the
  // hot-search term into the box) — never reuse it as the desired input.
  if (action.kind === "fill" || action.kind === "setDate") {
    action.value = await resolveFillValue(step, action);
    // A search step means "type the keyword AND submit" — but only when the
    // plan has no dedicated "click the search button" step right after.
    const idx = state.plan?.steps ? state.plan.steps.indexOf(step) : -1;
    if (step.verb === "search" && !nextStepIsSearchClick(state.plan?.steps, idx)) action.submit = true;
  }
  // Track tabs opened BY this action (window.open / target=_blank).
  const spawned = [];
  const onCreated = (t) => spawned.push(t.id);
  try { chrome.tabs.onCreated.addListener(onCreated); } catch { /* ignore */ }
  let actRes = await actOnTab(tabId, frameId, action);
  await sleep(300); // grace period for window.open to fire (SPA never spawns)
  try { chrome.tabs.onCreated.removeListener(onCreated); } catch { /* ignore */ }
  if (!actRes || !actRes.ok) {
    for (const s of spawned) closeTab(s);
    return { ok: false, verifyFrac: 0, verifyStr: "执行失败: " + (actRes?.reason || "未知") };
  }
  const point = actRes && Number.isFinite(actRes.cx) && Number.isFinite(actRes.cy)
    ? { x: actRes.cx, y: actRes.cy }
    : null;
  route.action = action; // keep the resolved value/submit flag on the route
  // Re-hover the trigger of a just-opened dropdown before clicking a dependent
  // item inside it (Pillar B). pendingRevealHover is set by runStep only when
  // this step consumes the menu opened by the previous step; consumed once.
  if (pendingRevealHover) {
    await cdpHover(pendingRevealHover.x, pendingRevealHover.y);
    await sleep(120);
    pendingRevealHover = null;
  }
  // Where did the state go? Acting tab navigated -> verify there. Otherwise,
  // if the action opened a new tab -> verify (and continue) there.
  let resultTabId = tabId;
  if (stripHash(await tabUrl(tabId)) === stripHash(beforeUrl) && spawned.length) {
    resultTabId = spawned[spawned.length - 1];
    await waitForSettle(resultTabId, 4000); // real new tab -> allow real load
  } else {
    await waitForSettle(tabId); // SPA: short settle by default
  }
  // A tab opened by the click (target=_blank) has no content script yet —
  // messaging it cold gets "no response" and the verification would score 0
  // even though the click landed. Ensure the script, then verify.
  if (resultTabId !== tabId) {
    const ensuredNew = await ensureContentScript(resultTabId);
    if (!ensuredNew.ok) {
      return { ok: true, verifyFrac: 0, verifyStr: "新标签无法注入: " + ensuredNew.reason, action, resultTabId, spawned };
    }
  }
  // Verify with a small retry: SPA pages (h3yun ERP etc.) are still on their
  // "加载中" skeleton right after settle, so the expected text may not be
  // rendered yet — re-check instead of failing a click that actually worked.
  let ver = null;
  for (let t = 0; t < 3; t++) {
    ver = await evaluateTab(resultTabId, defaultSpecFor(step, beforeUrl, obs?.ok ? obs.state : null), resultTabId === tabId ? frameId : null);
    if (ver && fracOf(ver.result) >= 0.5) break;
    await sleep(500);
  }
  const result = ver ? ver.result : null;
  // On a verifying success, propagate the judgment-layer's resolved term to the
  // goal's completion criterion. Only here (success) — never on a failing
  // candidate — so goalSuccessFired can't fire before the matching step ran.
  if (ver && fracOf(result) >= 0.5 && state.goal && state.goal.successCriteria) {
    const sc = state.goal.successCriteria;
    if (sc.value && (step.target === sc.value || (step.intent || "").includes(sc.value))) {
      sc.resolvedValue = action.label;
    }
    step.resolvedLabel = action.label; // re-affirm with the successful element
  }
  // via=cdp/inject 让日志能回答「这一步是谁填的、走哪条通道」（actOnTab 返回）。
  const via = actRes?.via ? ` via=${actRes.via}` : "";
  return { ok: true, verifyFrac: fracOf(result), verifyStr: summarize(result) + via, action, resultTabId, spawned, point };
}

const stepScore = (routeScore, verifyFrac) => Math.max(0.01, (routeScore + verifyFrac) / 2);

// A navigate step is already satisfied when the working tab's URL host
// matches the step's URL (e.g. "打开百度" while already on baidu.com).
function stepSatisfied(step, url) {
  if (!step || step.verb !== "navigate" || !step.url || !url) return false;
  try {
    const cur = new URL(url).hostname.replace(/^www\./, "");
    const want = new URL(step.url).hostname.replace(/^www\./, "");
    return cur === want || cur.endsWith("." + want) || want.endsWith("." + cur);
  } catch {
    return false;
  }
}

// Skip all currently-satisfied steps (advance index without executing).
function skipSatisfied(steps, idx, url) {
  let i = idx;
  while (i < steps.length && stepSatisfied(steps[i], url)) i++;
  return i;
}

// ---------- state reconciliation (Pillar A) ----------
// Label comparison for skip decisions uses calibrate's foldText (punctuation/
// space/case folded EXACT equality) — see targetPresent. The old loose
// bidirectional-substring matcher (labelMatches) is gone: it treated any
// page text containing the step's words as proof the next-step element
// existed, which skipped whole plan prefixes that never ran.
// Is the next-step element REALLY present? Strict on purpose:
//   1. EXACT match in the folded label space (punctuation/space/case folded)
//      — loose substring matching let "销售管理【最新】" or an unrelated app
//      shortcut stand in for the real menu item and derail whole runs;
//   2. UNIQUE — exactly one candidate. Two elements with the same folded label
//      means we cannot know which one the state claim is about; do not skip.
//   3. enabled + clickable (snapshot actions already are visibility-filtered).
function targetPresent(snap, query) {
  if (!snap || !snap.actions) return false;
  const q = foldText(query);
  if (!q) return false;
  const hits = snap.actions.filter(
    (a) => a.kind === "click" && !a.disabled && foldText(a.label) === q
  );
  return hits.length === 1;
}
// Decide whether a step's GOAL is ALREADY met by the current page, so the
// engine can skip it instead of firing an action that may toggle/close something.
//
// Only ONE case is trusted as a hard local skip (v0.4.12):
//  - fill/search step: the field LITERALLY holds the target value -> skip. This
//    is DIRECT state evidence (the field's actual value was read) — unambiguous.
//
// The OLD click-reveal case ("next target visible → skip the reveal click") was
// REMOVED: "next target visible" is NOT proof the reveal already happened — a
// multi-level dialog's same-named button can be visible for other reasons, so it
// wrongly skipped the step that opens the dialog and derailed the run. That STATE
// ASSESSMENT is now owned by the Route(LLM) layer (revealSkipCandidate +
// routeShouldSkip): only with an LLM key, and only after the LLM confirms the
// reveal effect is truly present. Without an LLM it never auto-skips.
function goalAlreadyMet(step, nextStep, snap, verifiedUpto, idx) {
  if (!snap) return { skip: false };
  if ((step.verb === "fill" || step.verb === "search") && (step.target || step.value)) {
    const t = step.value || step.target;
    if (t && snap.actions.some((a) => a.kind === "fill" && a.value && a.value.includes(t) && !a.disabled)) {
      return { skip: true, reason: `字段已含「${t}」` };
    }
  }
  return { skip: false };
}

// ---------- goal-driven (agentic) helpers ----------
// The noun the engine is currently chasing. In goal mode each hypothesis step's
// target IS a sub-goal noun, so we can read it straight off the step; this also
// lets Phase 3 advance subGoalIdx by checking which sub-goal is now satisfied.
function subGoalNoun() {
  // Prefer the CURRENT step's sub-goal anchor (Phase 6: refined child steps and
  // goal-entry steps both carry their subGoal), so the probe / success checks
  // stay aligned even after the plan has grown with extra child steps.
  const cur = state.plan && state.plan.steps && state.plan.steps[state.stepIndex];
  if (cur && cur.subGoal) return cur.subGoal;
  const g = state.goal;
  if (!g || !g.subGoals || !g.subGoals.length) return null;
  const i = Math.min(state.subGoalIdx, g.subGoals.length - 1);
  return g.subGoals[i]?.noun || null;
}

// The full objective string we hand to the Controller (LLM / planOneAction)
// during exploration. The fast Actor (Jev) owns the hot path; the LLM only
// plans/recovers, so it gets the WHOLE goal — ordered sub-goals, which one
// we're on, and what's already been done — not just the narrow step intent.
function goalContextString() {
  const g = state.goal;
  if (!g) return "";
  const sg = g.subGoals || [];
  return [
    g.goal,
    sg.length ? `子目标序列: ${sg.map((s) => s.noun).join(" → ")}` : "",
    `当前子目标(${state.subGoalIdx + 1}/${sg.length}): ${subGoalNoun() || "?"}`,
    state.controllerHistory.length
      ? `已执行: ${state.controllerHistory.slice(-4).join("; ")}`
      : "",
  ].filter(Boolean).join(" | ");
}
// picks the input box for fill steps instead of clicking random links.
function goalFor(step) {
  let g = step.intent;
  if (step.verb === "search") {
    g += "（动作类型: search，先在搜索框填入文字，再点击搜索/提交按钮完成搜索，不要点联想词或热榜链接）";
  } else if (step.verb) {
    // Every verb gets an explicit annotation (click included) — the decider
    // routes on this marker: fill candidates are dropped for click goals and
    // promoted for fill goals.
    g += `（动作类型: ${step.verb}）`;
  }
  if ((step.verb === "fill" || step.verb === "search") && (step.value || step.target)) {
    g += `（需要填入的文字: ${step.value || step.target}）`;
  }
  return g;
}

// ---------- manual single-step mode ----------
async function doStep(action) {
  const step = state.plan.steps[state.stepIndex];
  if (!step) return { ok: false, reason: "计划已完成" };
  const a = { ...action };
  if (a.kind === "fill") a.value = await resolveFillValue(step, a);
  const obs = await observeTab(state.workingTabId);
  const frameId = obs?.ok ? obs.frameId : null;
  let actRes = await actOnTab(state.workingTabId, frameId, a);
  if (!actRes || !actRes.ok) return { ok: false, reason: actRes?.reason || "act failed", action };
  await waitForSettle(state.workingTabId);
  const verRes = await evaluateTab(state.workingTabId, defaultSpecFor(step, obs?.state?.url || "", obs?.ok ? obs.state : null), frameId);
  const verify = verRes ? summarize(verRes.result) : "no result";
  state.history.push({ intent: step.intent, action: a, verify });
  step.status = "done";
  step.note = verify;
  state.stepIndex += 1;
  await observeRetry(state.workingTabId);
  await computeRoutes();
  return { ok: true, action: a, verify };
}

// ---------- full beam search ----------
// Each round: for every active path (a live tab), observe -> decide top-K ->
// duplicate the path's tab once per candidate -> execute + settle + verify on
// the duplicate -> pool all candidates -> keep Top-K (new active paths) ->
// close the rest. Paths that finish all steps are "done"; best done path wins.

// Trim a snapshot for per-step storage: keep identity + the actionable
// elements (with locators) so the panel can show the full step-time element
// tree without bloating memory across rounds.
function trimSnap(snap, max = 250) {
  if (!snap) return null;
  return {
    url: snap.url || "",
    title: snap.title || "",
    actions: (snap.actions || []).slice(0, max).map((a) => ({
      kind: a.kind, label: a.label, role: a.role, scope: a.scope, locator: a.locator, disabled: !!a.disabled,
    })),
  };
}

// Store a trimmed snapshot for plan step #idx (state-level, survives across
// beam runs; the panel's per-step tab renders it as "what the page looked
// like at this step").
function saveStepSnap(idx, snap) {
  if (idx == null || idx < 0) return;
  if (!state.stepSnaps) state.stepSnaps = {};
  const t = trimSnap(snap);
  if (t && t.actions.length) state.stepSnaps[idx] = t;
}

// Re-decide a step, preferring jev but promoting the LLM (deepseek) ranking when
// jev is clearly undecided (every candidate below the "decided" bar).
async function judgeStep(snap, step, history) {
  let decision = await decideTopK(snap, goalFor(step), state.run.width, config, state.model.pref, history);
  const top = Math.max(0, ...decision.routes.map((r) => r.score || 0));
  logLines(
    "JEV",
    `判定「${step.intent}」: provider=${decision.provider} · ${decision.routes.length} 候选 · top ${(top * 100).toFixed(0)}%` +
      ((decision.errors || []).length ? ` · 错误: ${decision.errors.join("; ")}` : ""),
    fmtCandidates(decision.routes)
  );
  if (decision.provider === "jev" && top < 0.3 && config.deepseekKey && state.model.pref !== "deepseek") {
    logLine("LLM", `jev 置信低（top ${(top * 100).toFixed(0)}% < 30%），升级 DeepSeek 重判定「${step.intent}」`);
    const llm = await decideTopK(snap, goalFor(step), state.run.width, config, "deepseek", history);
    const llmTop = Math.max(0, ...llm.routes.map((r) => r.score || 0));
    logLines("LLM", `DeepSeek 重判定: ${llm.routes.length} 候选 · top ${(llmTop * 100).toFixed(0)}%`, fmtCandidates(llm.routes));
    if (llm.routes.length && llmTop >= top) decision = llm;
  }
  return decision;
}

// Stable signature of an action's primary locator — the key for the run-level
// "failed element" memory. A locator that already failed verification in this
// run is never proposed or retried again (fresh re-judges filter it out).
function locatorSig(action) {
  const s = action?.locator?.strategies?.[0];
  const key = s
    ? s.type === "semantic"
      ? s.role + ":" + s.name
      : s.type + ":" + (s.selector || "")
    : action?.label || "";
  return (action?.kind || "") + "|" + key;
}

// Execution-trail entry: "第n步 <元素> 通过/未通过". Shown verbatim in the
// panel so the user always sees WHICH prefix of the plan is verified-good and
// exactly which step/element failed.
function pushTrail(n, label, ok, note) {
  if (!state.run) return;
  state.run.trail = state.run.trail || [];
  state.run.trail.push({ n, label: String(label || ""), ok: !!ok, note: String(note || "") });
  // 镜像到运行日志流：执行结果一行一条，原样可见。
  logLine(ok ? "执行" : "失败", `第${n}步 ${label || "?"} ${ok ? "✅" : "❌"}${note ? " · " + note : ""}`);
}

// Execute ONE candidate DIRECTLY on the working tab — the same primitive that
// made confirm mode "perfect every step". No duplicate tabs: the page the user
// sees is the page that acts, fills from earlier steps are already in place,
// and there is nothing to tear down between candidates. Follows target=_blank
// (resultTabId) and refreshes the snapshot to wherever the state now lives.
async function execRoute(step, route, idx) {
  const tabId = state.workingTabId;
  let exec;
  try {
    exec = await execCandidate(tabId, step, route);
  } catch {
    return null; // unexpected error -> treat as a failed attempt
  }
  if (!exec) return null;
  const resultTab = exec.resultTabId || tabId;
  if (resultTab !== tabId) {
    state.workingTabId = resultTab;
    try { chrome.tabs.update(resultTab, { active: true }); } catch { /* ignore */ }
  }
  await observeRetry(state.workingTabId);
  // Pillar B — reveal detection: a click that grew the DOM WITHOUT navigating
  // or opening a modal has opened a transient dropdown/menu (e.g. antd
  // Dropdown, a hover sub-list). Remember it so the NEXT step can keep it open
  // (re-hover the trigger) while clicking an item inside it. Modal dialogs are
  // excluded — they stay open on their own and are handled by inVisibleModal
  // resolution instead.
  const pre = step._prep && step._prep.snap;
  const post = state.lastState;
  if (pre && post && exec.point && !exec.resultTabId) {
    const grew = (post.candCount || 0) - (pre.candCount || 0) >= 2;
    const navd = (post.url || "").split("#")[0] !== (pre.url || "").split("#")[0];
    const modalChg =
      Number.isFinite(post.dialogs) && Number.isFinite(pre.dialogs) && post.dialogs !== pre.dialogs;
    if (grew && !navd && !modalChg) {
      state.run.openMenu = { stepIndex: idx, pt: exec.point };
    }
  }
  // Prefer exec.action (what ACTUALLY ran — fill value/submit resolved) over
  // the raw route action, so history records reality.
  return { ...exec, action: exec.action || route.action, verifyFrac: exec.verifyFrac, verifyStr: exec.verifyStr };
}

// Context for the browser-use agentic fallback: the helpers it needs plus tab
// hygiene hooks — shouldStop honors 停止, closeTab lets it clean up the tabs a
// failed attempt opened (taobao opens promos with target=_blank), and
// followResultTab moves the working tab to where the state actually lives.
function fallbackCtx(step, snap) {
  return {
    step, snap, tabId: state.workingTabId, cfg: config,
    sendToTab, waitForSettle, observeRetry, evaluateTab, goalFor,
    // In goal mode, point the Controller (browser-use loop / planOneAction) at
    // the WHOLE objective, not the narrow hypothesis step — that's what lets it
    // discover the unknown middle navigation (生产ERP2.0 → 销售管理) on its own.
    goalOverride: state.goalMode ? goalContextString() : null,
    // Phase 5: tell the fallback Controller which group to expand (no one-by-one).
    probeHint: state.goalMode ? (state.run?.probeHint || null) : null,
    closeTab, ensureContentScript, actOnTab, shouldStop: () => !state.run?.running,
  };
}

// After a successful fallback action the page state may live in a NEW tab the
// click opened (target=_blank). Follow it: switch workingTabId, activate the
// tab and refresh the snapshot — otherwise the next step observes a stale page.
async function followResultTab(tabId) {
  if (tabId && tabId !== state.workingTabId) {
    state.workingTabId = tabId;
    try { chrome.tabs.update(tabId, { active: true }); } catch { /* ignore */ }
  }
  await observeRetry(state.workingTabId);
}

// One step of the sequential engine: observe -> judge (jev) -> [confirm gate]
// -> fallback (llm / browser-use) -> slim-beam execute+verify -> advance only
// on verify pass. Returns { done } or { waited } (paused for user confirm).
// The judge result is cached on step._prep so RUN_APPROVE can resume straight
// into execution without re-observing / re-judging.
async function runStep(idx) {
  const steps = state.plan.steps;
  const step = steps[idx];
  // Defensive: never re-execute an already-completed step (e.g. after a Phase 6
  // rewind to a stable checkpoint). Skip-and-advance prevents runaway loops.
  if (step && step.status === "done") return { done: true, advance: 1 };
  // Goal mode: the hypothesis step at `idx` chases sub-goal `idx` — keep the
  // pointer in lock-step so subGoalNoun()/subGoalReached() resolve correctly.
  if (state.goalMode) state.subGoalIdx = idx;
  // --- Pillar B (menu continuity): if the PREVIOUS step opened a dropdown,
  // this step may need to consume it. Re-hover the trigger BEFORE observing so
  // the snapshot still contains the menu items, and flag the executor to keep
  // the menu open while clicking the dependent item. A menu tied to a
  // non-adjacent step is stale (steps were skipped/jumped) — close it. ---
  let dependent = false;
  let reopen = null;
  if (state.run.openMenu) {
    if (state.run.openMenu.stepIndex === idx - 1) {
      dependent = true;
      reopen = state.run.openMenu.pt;
      if (reopen) { await cdpHover(reopen.x, reopen.y); await sleep(120); }
    } else {
      await releaseHover();
      state.run.openMenu = null;
    }
  }
  if (!step._prep) {
    step.status = "observing";
    const obs = await observeRetry(state.workingTabId);
    if (!obs || !obs.ok) { step.status = "error"; step.note = obs?.reason || "观察失败"; return { done: false }; }
    saveStepSnap(idx, obs.state);
    state.run.preStepSnap = obs.state; // page state BEFORE this step's click, for drift/modal deltas in replan
    // navigate steps already satisfied by the current URL -> done, no action needed
    if (stepSatisfied(step, obs.state?.url || "")) {
      step.status = "done"; step.note = "页面已满足（自动跳过）";
      pushTrail(idx + 1, step.intent, true, "页面已满足");
      // URL match is HARD evidence the prefix advanced to here.
      state.run.verifiedUpto = Math.max(state.run.verifiedUpto ?? -1, idx);
      return { done: true };
    }
    // --- Pillar A (state reconciliation) ---
    // Fill/search steps: the field LITERALLY holds the target value — this is
    // direct state evidence, safe to skip without asking anyone.
    const met = goalAlreadyMet(step, steps[idx + 1], obs.state, state.run.verifiedUpto ?? -1, idx);
    if (met.skip) {
      step.status = "done";
      step.note = met.reason || "目标已满足（自动跳过）";
      pushTrail(idx + 1, step.intent, true, met.reason);
      state.run.verifiedUpto = Math.max(state.run.verifiedUpto ?? -1, idx);
      delete step._prep;
      return { done: true, advance: 1 };
    }
    // Click-reveal skip is NO LONGER a brittle local rule. "The next target is
    // already visible → skip the reveal click" is a STATE ASSUMPTION that went
    // astray (e.g. a multi-level export dialog's same-named button already
    // visible → wrongly skipped the step that opens the dialog). We hand that
    // judgment to the Route(LLM) layer for real page-state analysis: it decides
    // skip (reveal already happened) vs proceed (click still required). Without
    // an LLM this NEVER auto-skips — the re-observe loop lets jev decide, and
    // stuck-detection escalates to the human instead of silently going astray.
    if (config.deepseekKey) {
      const cand = revealSkipCandidate(step, steps[idx + 1], obs.state, state.run.verifiedUpto ?? -1, idx);
      if (cand) {
        logLine("LLM", `Route 判定请求：「${cand}」已在页面可见，判断揭示步是否可跳过`);
        try {
          const rj = await routeShouldSkip({ snap: obs.state, target: cand, goalContext: goalContextString(), noun: subGoalNoun(), cfg: config });
          if (rj) logLine("LLM", `Route 判定结果: ${rj.skip ? "skip（可跳过）" : "proceed（仍需点击）"}${rj.reason ? " · " + rj.reason : ""}`);
          if (rj && rj.skip) {
            step.status = "done";
            step.note = rj.reason || `Route 判定可跳过（${cand} 已就位）`;
            pushTrail(idx + 1, step.intent, true, rj.reason || "Route 判定跳过揭示步");
            state.run.verifiedUpto = Math.max(state.run.verifiedUpto ?? -1, idx);
            delete step._prep;
            return { done: true, advance: 1 };
          }
        } catch { /* LLM 不可达: 不跳过，交 jev 正常执行 */ }
      }
    }
    step.status = "judging";
    const decision = await judgeStep(obs.state, step, state.history);
    step._prep = { decision, snap: obs.state };
  }
  const { decision, snap } = step._prep;
  state.run.provider = decision.provider;
  // Keep the panel's "当前步骤候选路线" in sync with what this step was judged
  // on — otherwise it shows stale routes from a pre-run computeRoutes call.
  state.routes = decision.routes;
  state.routesMeta = {
    provider: decision.provider,
    errors: decision.errors || [],
    snapCount: (snap?.actions || []).filter((a) => a.kind !== "scroll" && a.kind !== "wait").length,
    url: snap?.url || "",
  };
  step.decision = {
    provider: decision.provider,
    candidates: decision.routes.map((r) => ({ kind: r.action.kind, label: r.action.label, score: r.score, tie: r.tie })),
    note: (decision.errors || []).join("; "),
  };
  const top = Math.max(0, ...decision.routes.map((r) => r.score || 0));

  // ---- confirm gate (step-by-step debug mode): pause AFTER judging so the
  // panel can show "what AI is about to do", BEFORE anything executes. RUN_
  // APPROVE re-enters runLoop with resumeIdx === idx, which passes the gate. ----
  if (state.run.confirmMode && state.run.resumeIdx !== idx) {
    step.status = "waiting";
    step.note = "等待确认";
    state.run.waiting = { stepIndex: idx };
    state.run.note = "待确认：第 " + (idx + 1) + " 步";
    logLine("人工", `⏸ 暂停：第 ${idx + 1} 步「${step.intent}」等待人工确认（决策: ${decision.provider}）`);
    return { waited: true };
  }
  state.run.resumeIdx = null;

  // Step-result helper (declared EARLY: the Phase 5 probe block below returns
  // through it on a direct hit — a later const would be a TDZ crash).
  const finish = (done, note) => {
    delete step._prep;
    if (note) step.note = note;
    // A REAL execution (verified pass / browser-use success) advances the
    // verified prefix — the anchor later Pillar A skips are allowed to stand on.
    if (done) state.run.verifiedUpto = Math.max(state.run.verifiedUpto ?? -1, idx);
    // The menu opened by the PREVIOUS step has now been consumed by this step —
    // clear it so the next observation starts from a clean (menu-closed) state.
    if (state.run.openMenu && state.run.openMenu.stepIndex === idx - 1) {
      state.run.openMenu = null;
      releaseHover().catch(() => {});
    }
    return { done };
  };

  // ---- Phase 5 (A+B): target-aware DOM probe BEFORE the controller wanders ----
  // On a multi-group sidebar the Controller would otherwise expand groups one by
  // one looking for e.g. "销售管理". The probe (1) clicks a VISIBLE target
  // directly, or (2) tells the fallback Controller exactly which group to expand,
  // skipping the rest. If the DOM probe is inconclusive AND a vision model is
  // configured, (B) screenshots the page and grounds the target by coordinates.
  if (state.goalMode && config.probeOn !== false) {
    // The probe chases the STEP'S OWN target when it has one (refined child
    // steps inherit the parent sub-goal "导出" but their real target is the
    // precise menu item "导出全部数据" — searching the inherited noun made the
    // probe exact-match the parent 导出 toolbar button and TOGGLE THE MENU
    // CLOSED right after jev had already found the item). Falls back to the
    // sub-goal noun only for steps without a concrete target (navigate etc.).
    const noun = (step.target || "").trim() ? step.target : subGoalNoun();
    const strat = config.sweepStrategy || "onDemand";
    const isLastStep = idx === (state.plan ? state.plan.steps.length - 1 : true);
    const sweepOpts = {
      maxSteps: Number(config.sweepMaxSteps) > 0 ? Number(config.sweepMaxSteps) : 6,
      stepRatio: Number(config.sweepStepRatio) > 0 ? Number(config.sweepStepRatio) : 0.8,
    };
    let interp = null;

    // v0.4.31: 滚动扫描策略（设置页可调）
    //  onDemand（默认/推荐）：仅视口探针未命中才滚动扫描（热路径零开销）
    //  everyStep / random / lastStep：执行前先做"预热滚动"触发懒加载，重采集
    //    快照让元素树出现下方折叠内容（如查看全部评价），再正常探针/扫描
    //  预热后回滚到原位置，避免页面停在底部破坏顶部目标（如搜索框）的点击。
    const wantWarm = strat !== "never" && (
      strat === "everyStep" || strat === "random" || (strat === "lastStep" && isLastStep)
    );
    if (wantWarm) {
      try {
        const w = await runProbeSweep(state.workingTabId, noun, { ...sweepOpts, mode: strat === "random" ? "random" : "warm" });
        if (w && w.ok && w.data) {
          logLine("探针", `滚动预热（${strat}）扫描 ${w.data.swept} 屏触发懒加载`);
          // 重采集快照：元素树（工作台）即时显示下方懒加载内容
          const ob = await observe(state.workingTabId);
          if (ob && ob.ok) saveStepSnap(idx, state.lastState);
        }
      } catch { /* probe best-effort */ }
    }

    try {
      const probe = await runProbe(state.workingTabId, noun);
      if (probe && probe.ok && probe.data) interp = interpretProbe(probe.data, noun);
      // v0.4.30: lazy-load scroll sweep — taobao/tmall render below-fold content
      // (评价区/查看全部评价) only when scrolled near, so BOTH the snapshot and
      // the viewport probe miss it. Only swept when the viewport probe found
      // NOTHING (never on the hot path); bounded (≤6 screens); restores scroll
      // when it finds nothing so vision/Route judge the original page.
      if ((!interp || interp.mode === "none") && strat !== "never") {
        const sweep = await runProbeSweep(state.workingTabId, noun, sweepOpts);
        if (sweep && sweep.ok && sweep.data) {
          const si = interpretProbe(sweep.data, noun);
          if (si && si.mode !== "none") {
            interp = si;
            logLine("探针", `滚动扫描第 ${sweep.data.swept} 屏命中「${si.text || noun}」(${si.x},${si.y})（页面停在命中处，坐标即时有效）`);
          } else {
            logLine("探针", `滚动扫描 ${sweep.data.swept || 0} 屏至页底仍无命中（已回滚原位）`);
          }
        }
      }
    } catch { /* probe is best-effort */ }
    state.run.lastProbe = interp || { mode: "none" };
    logLine(
      "探针",
      `DOM 探针「${noun}」: ` + (interp
        ? interp.mode === "click"
          ? `命中可见目标「${interp.text || noun}」(${interp.x},${interp.y}) → 直接点击`
          : interp.mode === "expand"
            ? `目标隐藏于分组「${interp.containerLabel}」→ 提示兜底展开`
            : interp.mode === "route"
              ? `按分组头「${interp.headerText}」语义路由（相似度 ${interp.score}）`
              : "无 actionable 命中"
        : (strat === "never" && (!interp || interp.mode === "none") ? "（滚动扫描已关闭）" : "探针不可用/失败"))
    );

    // Probe-vs-jev arbitration via the single pure policy (lib/probe-policy.js).
    // jev is the actor; the probe is a fallback that may take the click ONLY
    // when jev has no usable decision AND its hit is a STRONG match. The lock
    // bar is operator-tunable (功能配置: 探针接管临界 = config.probeLockBar).
    const topRoute = decision.routes[0];
    const jevHasDecision = !!topRoute && top > 0;
    const probeScore = interp && interp.mode === "click" ? (interp.score || 0) : 0;
    // v0.4.30: is jev's top pick word-aligned with the step's target noun? When
    // the real target only exists below the fold, jev's confident candidate is
    // unrelated noise — a STRONG probe hit (exact 查看全部评价) must then win.
    const jevAligned = topRoute ? goalAligned(topRoute.action, targetOf(goalFor(step))) : undefined;
    const who = decideExecutor({ jevHasDecision, jevTop: top, probeScore, lockBar: Number(config.probeLockBar) || 0.6, jevAligned });
    if (interp && interp.mode === "click" && who === "jev") {
      logLine("探针", `探针命中「${interp.text || noun}」(${Math.round(probeScore * 100)}%)，但 jev 决策可用（top ${Math.round(top * 100)}%「${topRoute.action.label}」），交 jev 执行`);
    }
    if (interp && interp.mode === "click" && who === "probe") {
      const ok = await execProbeClick(interp.x, interp.y);
      if (ok) {
        pushTrail(idx + 1, "探针直接命中「" + (interp.text || noun) + "」", true, "DOM 探针定位 + CDP 可信点击");
        if (state.goalMode) state.controllerHistory.push(step.intent);
        await followResultTab(state.workingTabId);
        saveStepSnap(idx, state.lastState);
        return finish(true);
      }
    }

    let hint = null;
    if (interp && interp.mode === "expand")
      hint = `目标「${noun}」当前隐藏在分组「${interp.containerLabel}」中，请先点击该分组的标题或箭头将其展开，不要逐个尝试其他分组。`;
    else if (interp && interp.mode === "route")
      hint = `页面分组头候选中，「${interp.headerText}」与子目标「${noun}」最相关（相似度 ${interp.score}），请优先展开并查找该分组。`;
    else if (config.vision && (config.visionKey || config.deepseekKey)) {
      // Phase 5-B: vision grounding fallback when DOM probe found nothing actionable.
      logLine("LLM", `vision grounding 请求：截图 + 定位「${noun}」`);
      try {
        const shot = await captureScreenshot(state.workingTabId);
        if (shot && shot.ok) {
          const g = await groundVision(config, shot.data, noun);
          logLine("LLM", "vision grounding 结果: " + (g ? (g.mode === "click" ? `命中 (${g.fx},${g.fy})` : g.mode) : "null（未定位）"));
          if (g && g.mode === "click") {
            const vp = await getViewport(state.workingTabId);
            if (vp) {
              const ok = await execProbeClick(Math.round(g.fx * vp.w), Math.round(g.fy * vp.h));
              if (ok) {
                pushTrail(idx + 1, "视觉定位命中「" + noun + "」", true, "截图 + vision grounding + CDP 点击");
                if (state.goalMode) state.controllerHistory.push(step.intent);
                await followResultTab(state.workingTabId);
                saveStepSnap(idx, state.lastState);
                return finish(true);
              }
            }
          } else if (g && g.mode === "expand") {
            hint = `视觉模型判断目标在「${g.group}」分组内，请先展开该分组再查找。`;
          }
        }
      } catch { /* vision fallback is best-effort */ }
    }
    state.run.probeHint = hint;
  }

  // ---- Route layer (Plan-and-Execute): LLM 判路线, jev 执行 ----
  // 进入方向型子目标、jev 拿不准、或 DOM 探针无果时，调 LLM 判路线：若它给出路径，
  // 就把具体步骤追加给 jev 去点；若判定不可达，升级人工。这把 LLM 从「jev 失败兜底」
  // 变成了「子目标边界的路线裁判」，正是 jev/LLM 分工的本质。
  if (state.goalMode && !step.routeConsulted) {
    const noun = subGoalNoun();
    if (needsRoute({ step, top, llmAvailable: !!config.deepseekKey && config.routeOn !== false, probeMode: state.run.lastProbe?.mode, lowConfBar: Number(config.routeTopBar) || undefined })) {
      step.routeConsulted = true;
      logLine("LLM", `Route 判路线请求：子目标「${noun}」${top < 0.3 ? `（jev top ${(top * 100).toFixed(0)}% 偏低）` : "（方向型子目标边界）"}`);
      let rj = null;
      try {
        rj = await routeJudge({
          snap,
          goalContext: goalContextString(),
          noun,
          remainingSubGoals: (state.goal?.subGoals || []).map((s) => s.noun),
          lastAction: (state.history || []).slice(-1)[0]?.action || null,
          cfg: config,
        });
      } catch (e) {
        logLine("LLM", "Route 判路线失败: " + (e?.message || e));
      }
      if (rj) logLine("LLM", `Route 判路线结果: mode=${rj.mode}${rj.reason ? " · " + rj.reason : ""}`);
      if (rj && rj.mode === "route") {
        applyReplan({ append: rj.steps.map((s) => ({ ...s, afterIdx: idx, expandOf: idx })) });
        pushTrail(idx + 1, "路线裁判追加 " + rj.steps.length + " 步", true, "LLM 判路线");
        if (state.goalMode) state.controllerHistory.push(step.intent);
        step.status = "done";
        step.note = "路线裁判已规划后续步骤";
        return finish(true);
      }
      if (rj && rj.mode === "direct") {
        // LLM 判定"直接点当前目标即可"：不追加冗余步（旧行为会把同目标 append 成
        // 新步再走一轮 jev，多花一整轮循环），直接 fall through 让 jev 执行当前步。
        logLine("LLM", "Route 判定可直接点击，当前步交 jev 执行");
      }
      if (rj && rj.mode === "blocked") {
        logLine("人工", `🛑 Route 判定不可达，升级人工: ${rj.reason || ""}`);
        state.run.running = false;
        state.run.waiting = { stepIndex: idx, askHuman: true, question: rj.reason };
        state.run.note = rj.reason;
        persistState();
        return { waited: true };
      }
      // rj 为 null -> 降级到下方 jev 执行 / browser-use 兜底
    }
  }

  // ---- fallback chain: jev -> llm already tried in judgeStep; if still no
  // usable candidate (or everyone below the act bar) hand off to browser-use ----
  // In goal mode with a DOM-probe hint, lower the bar so we hand off to the
  // Controller (which consumes the hint) instead of trusting jev's middling pick.
  if (!decision.routes.length || top < (state.goalMode && state.run.probeHint ? 0.45 : 0.2)) {
    step.status = "fallback";
    logLine("兜底", `无可用候选（top ${(top * 100).toFixed(0)}%），启动 browser-use 兜底「${step.intent}」`);
    const bu = await browserUseFallback(fallbackCtx(step, snap));
    logLine("兜底", "browser-use 结果: " + (bu.ok ? "成功" : "失败") + (bu.note ? " · " + bu.note : ""));
    step.note = (step.note ? step.note + " | " : "") + "browser-use: " + (bu.note || "");
    if (bu.ok) {
      await followResultTab(bu.tabId);
      saveStepSnap(idx, state.lastState);
      pushTrail(idx + 1, "browser-use 兜底", true, bu.note || "");
      if (state.goalMode) state.controllerHistory.push(step.intent);
      return finish(true);
    }
    step.status = "error";
    pushTrail(idx + 1, step.intent, false, step.note);
    return finish(false);
  }

  // ---- execute + verify: DIRECT sequential execution on the working tab, in
  // both modes. The old duplicate-tab slim-beam opened K copies per step and
  // tore them down every round — tab-close / state-refresh races bled into the
  // next round ("上一轮还没清理完就进下一轮"), and duplicates reload the page
  // so typed fills needed replaying. Confirm mode already proved direct
  // execution works every step, so auto mode uses the SAME primitive:
  //   1. try candidates in ranked order — a failed locator is remembered for
  //      the whole run and never proposed again;
  //   2. if every ranked candidate failed, re-observe + re-judge FRESH
  //      (the page moved under us) and try up to 2 new routes;
  //   3. only then hand off to the browser-use fallback. ----
  step.status = "executing";
  state.run.failedSigs = state.run.failedSigs || [];
  const attempt = async (route, force = false) => {
    if (dependent) pendingRevealHover = reopen; // keep the menu open across this try
    const sig = locatorSig(route.action);
    if (!force && state.run.failedSigs.includes(sig)) return null;
    const r = await execRoute(step, route, idx);
    if (r && r.ok && r.verifyFrac >= 0.5) return r;
    // Remember the failure for the rest of this run + surface WHY in the note
    // (verifyStr carries the click_effect numbers: url/text/dom/modal).
    if (!state.run.failedSigs.includes(sig)) state.run.failedSigs.push(sig);
    if (r && r.verifyStr) {
      step.note = (step.note ? step.note + " | " : "") +
        `候选「${route.action.label || "?"}」未通过校验: ${r.verifyStr}`;
      logLine("失败", `候选「${route.action.label || "?"}」未通过校验: ${r.verifyStr}（加入失败记忆）`);
    }
    return null;
  };
  let best = null;
  // Goal-alignment gate inputs: the step's target noun and the page/tab the
  // step STARTED on (revert returns there when a wrong click "passes").
  const baseTabId = state.workingTabId;
  const preUrl = snap?.url || "";
  const gateTarget = targetOf(goalFor(step));
  if (state.run.confirmMode) {
    // The user approved THIS exact route — execute exactly it, no exploration,
    // no gate (the human is the alignment check).
    best = decision.routes[0] ? await attempt(decision.routes[0], true) : null;
  } else {
    // ---- goal-alignment gate ----
    // click_effect alone answers "did the page change?", never "did the page
    // change TOWARD THE GOAL?" — so a wrong click (logo, notification card,
    // random nav link) passes verification, derails every later step and the
    // trail still shows green. Architectural fix: a passing element whose
    // wording does NOT agree with the step's target noun is not trusted while
    // an UNTRIED route DOES agree — the click is undone (revertTab) and the
    // agreeing route gets tried instead, on the page the step started from.
    const tried = [];
    for (const route of decision.routes.slice(0, 3)) {
      if (!state.run.running) break;
      const r = await attempt(route);
      tried.push(route);
      if (!r) continue;
      const alignedLater = decision.routes.some(
        (rt) => !tried.includes(rt) && !state.run.failedSigs.includes(locatorSig(rt.action)) && goalAligned(rt.action, gateTarget)
      );
      if (!goalAligned(r.action, gateTarget) && alignedLater) {
        const sig = locatorSig(route.action);
        if (!state.run.failedSigs.includes(sig)) state.run.failedSigs.push(sig);
        step.note = (step.note ? step.note + " | " : "") +
          `候选「${route.action.label || "?"}」已生效但与目标「${gateTarget}」词面无关，已回退`;
        pushTrail(idx + 1, route.action.label, false, "与目标词面无关，已回退");
        await revertTab(baseTabId, preUrl);
        continue;
      }
      best = r;
      break;
    }
    if (!best && state.run.running) {
      // The agreeing route may rank below the top-3 (wrong-but-plausible
      // candidates crowded it out). Try up to 2 untried ALIGNED routes from
      // the FULL ranked list before spending a fresh re-judge.
      const alignedRest = decision.routes
        .filter((rt) => !tried.includes(rt) && !state.run.failedSigs.includes(locatorSig(rt.action)) && goalAligned(rt.action, gateTarget))
        .slice(0, 2);
      for (const route of alignedRest) {
        if (!state.run.running) break;
        const r = await attempt(route);
        if (r) { best = r; break; }
      }
    }
    if (!best && state.run.running) {
      // Fresh re-judge: failed attempts may have moved the page; observe the
      // CURRENT state and decide again, excluding everything that failed.
      step.status = "judging";
      const obs2 = await observeRetry(state.workingTabId);
      if (obs2 && obs2.ok) {
        saveStepSnap(idx, obs2.state);
        const d2 = await judgeStep(obs2.state, step, state.history);
        state.routes = d2.routes; // keep the panel candidate list in sync
        state.routesMeta = {
          provider: d2.provider, errors: d2.errors || [],
          snapCount: (obs2.state?.actions || []).filter((a) => a.kind !== "scroll" && a.kind !== "wait").length,
          url: obs2.state?.url || "",
        };
        const fresh = d2.routes.filter((rt) => !state.run.failedSigs.includes(locatorSig(rt.action)));
        for (const route of fresh.slice(0, 2)) {
          if (!state.run.running) break;
          best = await attempt(route);
          if (best) break;
        }
      }
    }
  }
  step.status = "verifying";
  if (best && best.verifyFrac >= 0.5) {
    step.status = "done";
    state.history.push({ intent: step.intent, action: best.action, verify: best.verifyStr });
    pushTrail(idx + 1, best.action.label, true, best.verifyStr);
    // Record the AFTER page (execRoute refreshed lastState) so the panel's
    // per-step element tree shows where the run actually is.
    saveStepSnap(idx, state.lastState);
    if (state.goalMode) state.controllerHistory.push(best?.action?.label || step.intent);
    return finish(true, best.verifyStr);
  }
  // ---- still failed -> last-resort browser-use on the working tab.
  // Keep WHY jev failed (verifyStr carries the click_effect detail: url/text/
  // dom/modal numbers) in the note — without it the panel can't show what the
  // verification actually measured. ----
  step.status = "fallback";
  logLine("兜底", `候选全部失败，最后兜底 browser-use「${step.intent}」`);
  const bu2 = await browserUseFallback(fallbackCtx(step, snap));
  logLine("兜底", "browser-use 结果: " + (bu2.ok ? "成功" : "失败") + (bu2.note ? " · " + bu2.note : ""));
  const parts = [];
  if (best && best.verifyStr) parts.push("校验: " + best.verifyStr);
  if (step.note) parts.push(step.note);
  parts.push("browser-use: " + (bu2.note || ""));
  step.note = parts.join(" | ");
  if (bu2.ok) {
    await followResultTab(bu2.tabId);
    saveStepSnap(idx, state.lastState);
    pushTrail(idx + 1, "browser-use 兜底", true, bu2.note || "");
    if (state.goalMode) state.controllerHistory.push(step.intent);
    return finish(true);
  }
  step.status = "error";
  step.note = (step.note || "") + "（jev/llm/browser-use 均未通过校验）";
  pushTrail(idx + 1, step.intent, false, step.note);
  return finish(false);
}

async function runPlan(k = 3, confirm = false) {
  if (!state.plan || !state.plan.steps.length) return { ok: false, reason: "请先在 Agent 里描述自动化步骤" };
  const base = state.workingTabId || (await activeTab())?.id;
  if (!base) {
    // Fire-and-forget callers surface failures via run.note (GET_STATE poll).
    state.run = { running: false, mode: "sequential", width: Math.max(2, Math.min(5, k || 3)), round: 0, stepIndex: state.stepIndex, provider: "", note: "没有可用标签页", waiting: null, resumeIdx: null };
    return { ok: false, reason: "没有可用标签页" };
  }
  state.workingTabId = base;
  const width = Math.max(2, Math.min(5, k || 3));
  state.run = { running: true, mode: "sequential", width, round: 0, stepIndex: state.stepIndex, provider: "", note: "", confirmMode: !!confirm, waiting: null, resumeIdx: null, trail: [], failedSigs: [], openMenu: null, verifiedUpto: state.stepIndex - 1,
    // Phase 3 loop-governance + success tracking
    downloadFired: false, stagnantStreak: 0, repeatActionStreak: 0, lastPageSig: null, lastAction: null, goalAchieved: false };
  logLine("系统", `▶ 启动执行（智能模式 · K=${width}${confirm ? " · 逐步确认" : ""} · 共 ${state.plan.steps.length} 步）`);
  // Mark already-satisfied leading navigate steps done up front.
  const firstObs = await observeRetry(base);
  if (firstObs && firstObs.ok) {
    const skipped = skipSatisfied(state.plan.steps, state.stepIndex, firstObs.state?.url || "");
    if (skipped > state.stepIndex) {
      for (let i = state.stepIndex; i < skipped; i++) {
        state.plan.steps[i].status = "done";
        state.plan.steps[i].note = "页面已满足（自动跳过）";
        pushTrail(i + 1, state.plan.steps[i].intent, true, "页面已满足");
      }
      state.stepIndex = skipped;
      saveStepSnap(state.stepIndex, firstObs.state);
    }
  }
  await runLoop();
}

// ---------- Phase 6: apply a replan() edit set to the live plan ----------
// DROP only MARKS steps `dropped` (we keep them in the array so indices stay
// stable and runStep simply skips them) — this avoids splice-index hell. APPEND
// splices child steps after the parent; we mark the parent `expanded` so it is
// never expanded twice. Order: drop-mark first (no length change), then append.
function applyReplan(edits) {
  if (!edits) return;
  const steps = state.plan.steps;
  if (edits.drop && edits.drop.length) {
    for (const i of edits.drop) {
      const s = steps[i];
      if (s && s.status !== "done") { s.status = "dropped"; s.note = "已裁剪（冗余/偏离）"; }
    }
  }
  if (edits.append && edits.append.length) {
    // Insert after the referenced parent, preserving order.
    let at = edits.append[0].afterIdx + 1;
    for (const a of edits.append) {
      const step = {
        intent: a.intent, verb: a.verb || "click", target: a.target,
        subGoal: a.subGoal, kind: a.kind || "refined",
        expandable: !!a.expandable, expanded: false,
        status: "pending", decision: null, note: a.note || "",
        expandOf: a.expandOf != null ? a.expandOf : null,
        // Steps produced by the Route(LLM) layer already carry a concrete target,
        // so they must never re-trigger the route layer (prevents infinite loops).
        routeConsulted: true,
      };
      steps.splice(at, 0, step);
      at += 1;
    }
    const parent = steps[edits.append[0].afterIdx];
    if (parent) parent.expanded = true;
  }
  if (edits.jumpTo != null) { state.stepIndex = edits.jumpTo; state.run.replanJumped = true; }
}

// ---- Step 0 / Step 1 helpers: plan-exhaustion handling ----
// Ask the Route(LLM) layer to extend the plan when the step list is exhausted
// but the goal's success signal hasn't fired yet. Appends concrete steps for jev
// to execute; returns true if anything was appended.
async function tryRouteExtend() {
  if (!config.deepseekKey) return false;
  const noun = subGoalNoun();
  let rj = null;
  try {
    rj = await routeJudge({
      snap: state.lastState,
      goalContext: goalContextString(),
      noun,
      remainingSubGoals: (state.goal?.subGoals || []).map((s) => s.noun),
      lastAction: (state.history || []).slice(-1)[0]?.action || null,
      cfg: config,
    });
  } catch { return false; }
  if (rj && (rj.mode === "route" || rj.mode === "direct")) {
    const steps = rj.mode === "route"
      ? rj.steps
      : [{ intent: rj.target, verb: "click", target: rj.target, subGoal: noun, kind: "refined", expandable: false }];
    const afterIdx = state.plan.steps.length - 1;
    applyReplan({ append: steps.map((s) => ({ ...s, afterIdx, expandOf: afterIdx })) });
    pushTrail(state.stepIndex + 1, "路线裁判补全 " + steps.length + " 步（步骤耗尽后）", true, "LLM 判路线");
    return true;
  }
  return false;
}

// Plan exhausted but the goal's success signal never fired, and the Route layer
// can't extend it: this is a genuine failure, not a clean "done". Surface it to
// the human instead of misreporting "未观测到明确成功信号".
async function escalateExhausted() {
  logLine("人工", "🛑 步骤耗尽且 Route 层无法补全，升级人工确认");
  state.run.running = false;
  state.run.waiting = {
    stepIndex: state.stepIndex,
    askHuman: true,
    question: stuckQuestion(subGoalNoun(), "已执行完所有已知步骤但目标成功信号未触发，需人工确认或补充路线"),
  };
  state.run.note = "步骤耗尽且未达成目标（成功信号未触发）";
  persistState();
}

// The sequential driver loop. Exits cleanly when paused for confirmation (the
// RUN_APPROVE / RUN_SKIP handlers re-enter it), stopped, or finished — so the
// service worker is never stuck awaiting user input. Guarded by `loopActive` so a
// stale loop (e.g. from a pre-restart worker) can never run in parallel.
let loopActive = false;
async function runLoop() {
  if (loopActive) return;
  loopActive = true;
  try {
    let ok = true;
    while (state.run?.running) {
      // Phase 6: skip steps that reflective re-planning has pruned (status
      // "dropped"). Kept in the array (not spliced) so indices stay stable.
      while (state.stepIndex < state.plan.steps.length && state.plan.steps[state.stepIndex].status === "dropped") {
        state.stepIndex += 1;
      }
      // ---- Step 0: 步骤耗尽的处理（导出 bug 的真正根因修复）----
      // 在 goal 模式里，步骤跑完≠目标达成：Controller 可能在成功信号触发前就把已知
      // 步骤耗尽了。此时绝不能干净结束（否则误报"未观测到成功信号"），而是：
      //   成功信号已触发 -> 真正完成；否则让 Route(LLM) 补全步骤；补不出 -> 升级人工。
      // 顺序模式(无 goal) 才把"步骤耗尽"当作完成。
      if (state.stepIndex >= state.plan.steps.length) {
        // ---- Step 耗尽：完成裁判（LLM 语义判断）是权威出口 ----
        // 先走确定性信号快路径（如 download 已触发）；否则由 DeepSeek 看最终页面 +
        // 日志判断用户【语义目标】是否真达成。这一步解决了「导出所有合同记录」：
        // 仅点了导出 ≠ 完成（对话框可能还开着/没选范围/没真下载），LLM 会给出 missing 步骤。
        // ---- deterministic safety net: a download is the authority for an
        // "导出/下载" goal even if the success-criteria signal is worded
        // differently. Catches the case where the file already started writing. ----
        if (state.run.downloadFired) {
          logLine("系统", "✅ 观测到下载已触发，目标达成");
          await finishRun(true, "目标达成 ✅（下载已触发）");
          return;
        }
        const deterministicDone = state.goal && goalSuccessFired(
          state.goal.successCriteria,
          {
            lastState: state.lastState,
            downloadFired: state.run.downloadFired,
            controllerHistory: state.controllerHistory,
            history: state.history,
            subGoalNoun: subGoalNoun(),
          }
        );
        if (deterministicDone) {
          logLine("系统", "✅ 成功信号已触发，目标达成");
          await finishRun(true, "目标达成 ✅（成功信号已触发：" + (state.goal?.successCriteria?.note || "") + "）");
          return;
        }
        if (config.deepseekKey) {
          logLine("LLM", "步骤耗尽，调用完成裁判判断语义目标是否达成…");
          let verdict = null;
          try {
            verdict = await goalComplete({
              goal: state.goal?.goal,
              subGoals: state.goal?.subGoals,
              successCriteria: state.goal?.successCriteria,
              snap: state.lastState,
              runLog: state.runLog,
              downloadFired: state.run.downloadFired,
              history: state.history,
              cfg: config,
            });
          } catch (e) {
            verdict = { done: false, reason: "完成裁判调用出错: " + (e && e.message ? e.message : e), missing: [] };
          }
          // If the LLM judge is inconclusive (unparseable / empty response), do
          // NOT escalate immediately — fall back to deterministic success signals.
          // A download or a closed dialog with the right action history IS success
          // even when the model glitches on its JSON (the "完成裁判应答无法解析"
          // case that used to bounce every export to 人工).
          const judgeInconclusive = !verdict || !verdict.reason || verdict.reason.includes("无法解析");
          if (judgeInconclusive) {
            const detDone = state.goal && goalSuccessFired(
              state.goal.successCriteria,
              {
                lastState: state.lastState,
                downloadFired: state.run.downloadFired,
                controllerHistory: state.controllerHistory,
                history: state.history,
                subGoalNoun: subGoalNoun(),
              }
            );
            if (detDone) {
              logLine("系统", "✅ 完成裁判无法解析，但确定性成功信号命中，目标达成");
              await finishRun(true, "目标达成 ✅（完成裁判无法解析→确定性信号命中）");
              return;
            }
          }
          if (verdict && verdict.done) {
            logLine("系统", "✅ 完成裁判：目标已达成（" + (verdict.reason || "") + "）");
            await finishRun(true, "目标达成 ✅（LLM 完成裁判：" + (verdict.reason || "") + "）");
            return;
          }
          const missing = (verdict && verdict.missing) || [];
          if (missing.length && (state.run.routeExtends || 0) < (state.run.maxExtends || 5)) {
            const afterIdx = state.plan.steps.length - 1;
            const appended = missing.map((m) => ({
              intent: m.intent || "点击 " + (m.target || ""),
              verb: m.verb || "click",
              target: m.target || "",
              subGoal: subGoalNoun(),
              kind: "refined",
              expandable: false,
              expandOf: afterIdx,
            }));
            applyReplan({ append: appended.map((s) => ({ ...s, afterIdx })) });
            state.run.routeExtends = (state.run.routeExtends || 0) + 1;
            logLine("LLM", `完成裁判：未完成（${verdict?.reason || ""}），补全 ${appended.length} 步后继续`);
            await sleep(300);
            continue;
          }
          logLine("LLM", "完成裁判：未完成且无法补全（" + (verdict?.reason || "无缺失步骤") + "），升级人工");
          await escalateExhausted();
          return;
        }
        // 无 Key：无 LLM 裁判，退回到确定性路由补全
        const action = planExhaustedAction({
          goalMode: state.goalMode,
          successFired: false,
          routeExtended: false,
          routeExtends: state.run.routeExtends || 0,
        });
        if (action === "success") { await finishRun(true, "目标达成 ✅"); return; }
        if (action === "normal") break;
        if (action === "escalate") { await escalateExhausted(); return; }
        const extended = await tryRouteExtend();
        if (extended) {
          state.run.routeExtends = (state.run.routeExtends || 0) + 1;
          await sleep(300);
          continue;
        }
        await escalateExhausted();
        return;
      }
      // Track the current step number, not loop entries — RUN_APPROVE re-enters
      // the loop per confirmation, which made "轮次" jump (轮次 4 on step 2).
      state.run.round = state.stepIndex + 1;
      state.run.stepIndex = state.stepIndex;
      const r = await runStep(state.stepIndex);
      persistState(); // survive worker restarts mid-run
      if (r.waited) return; // paused for user confirmation
      if (!state.run.running) { state.run.note = "用户已停止"; break; }
      if (!r.done) { ok = false; state.run.note = "在第 " + (state.stepIndex + 1) + " 步失败"; break; }
      // ---- Phase 3: explicit goal-done detection (success signal beats step count) ----
      // The run is complete the moment the GOAL's success criterion fires — even
      // if there are still un-ticked hypothesis steps, or even if Pillar A left
      // some reveals skipped. This is what stops "steps clicked ≠ goal done".
      if (state.goalMode && goalSuccessFired(
        state.goal?.successCriteria,
        {
          lastState: state.lastState,
          downloadFired: state.run.downloadFired,
          controllerHistory: state.controllerHistory,
          history: state.history,
          subGoalNoun: subGoalNoun(),
        }
      )) {
        logLine("系统", "✅ 成功信号已触发（每步检查），目标达成");
        await finishRun(true, "目标达成 ✅（成功信号已触发：" + (state.goal?.successCriteria?.note || "") + "）");
        return;
      }
      // ---- Phase 3: loop governance (stop & ask human when stuck) ----
      // In goal mode a stuck Controller would otherwise spin forever chasing a
      // sub-goal that isn't there. Track page stasis + action repetition; past
      // the thresholds, halt and surface a question to the human.
      const prevPageSig = state.run.lastPageSig; // pre-update signature, for Phase 6 drift
      if (state.goalMode) {
        const last = (state.history || []).slice(-1)[0];
        const act = last ? (last.action?.label || "") + "|" + (last.action?.kind || "") : null;
        const sig = pageSig(state.lastState);
        if (sig && sig === state.run.lastPageSig) state.run.stagnantStreak = (state.run.stagnantStreak || 0) + 1;
        else { state.run.stagnantStreak = 0; state.run.lastPageSig = sig; }
        if (act && act === state.run.lastAction) state.run.repeatActionStreak = (state.run.repeatActionStreak || 0) + 1;
        else { state.run.repeatActionStreak = 0; state.run.lastAction = act; }
        const stuck = checkStuck(state.run, subGoalNoun());
        if (stuck.stuck) {
          logLine("人工", `🛑 卡死检测: ${stuck.reason}`);
          state.run.running = false;
          state.run.waiting = { stepIndex: state.stepIndex, askHuman: true, question: stuckQuestion(subGoalNoun(), stuck.reason) };
          state.run.note = stuck.reason;
          persistState();
          return;
        }
      }
      // ---- Phase 6: deterministic reflective re-plan (grow / shrink) ----
      // The static hypothesis plan can't know that "导出" is really a multi-level
      // sequence. After every step we reflect on the new page state and either
      // GROW (append the related buttons a sub-goal just revealed) or SHRINK
      // (prune redundant refined steps once the target view is reached, or rewind
      // on page drift). Pure function in lib/replan.js; we just apply the edits.
      if (state.goalMode) {
        const edits = replan({
          steps: state.plan.steps,
          idx: state.stepIndex,
          snap: state.lastState,
          subGoalNoun: subGoalNoun(),
          successCriteria: state.goal?.successCriteria,
          controllerHistory: state.controllerHistory,
          history: state.history,
          downloadFired: state.run.downloadFired,
          lastPageSig: prevPageSig, // pre-update signature for drift recovery
          prevSnap: state.run.preStepSnap, // pre-step page state for modal/page-change deltas
          goalText: state.goal?.goal || "", // 互斥范围选项（全部/已选/当前页）按目标语义收敛
        });
        applyReplan(edits);
        if (edits.append?.length) logLines("反射", `Phase 6 反射追加 ${edits.append.length} 步`, edits.append.map((s) => `${s.intent}（${s.target || ""}）`));
        if (edits.drop?.length) logLine("反射", `Phase 6 反射裁剪 ${edits.drop.length} 步: ${edits.drop.map((i) => i + 1).join(",")}`);
        if (edits.done) {
          logLine("系统", "✅ 反射判定目标达成");
          await finishRun(true, "目标达成 ✅（成功信号已触发：" + (state.goal?.successCriteria?.note || "") + "）");
          return;
        }
        if (edits.note) pushTrail(state.stepIndex + 1, edits.note, true, "Phase 6 反射");
      }
      if (state.run.replanJumped) state.run.replanJumped = false; // rewind already set the index; don't also advance
    else state.stepIndex += r.advance || 1; // reconciliation may skip a pair at once
      await sleep(300);
    }
    await finishRun(ok);
  } finally {
    loopActive = false;
  }
}

async function finishRun(ok, achievedNote) {
  state.run.running = false;
  state.run.waiting = null;
  logLine("系统", "■ 运行结束" + (achievedNote ? ": " + achievedNote : ok ? "：计划完成" : ""));
  if (achievedNote) {
    // Phase 3: the GOAL's success signal fired — this is the real "done".
    state.run.note = achievedNote;
    state.run.goalAchieved = true;
  } else if (state.stepIndex >= state.plan.steps.length && state.run.note !== "用户已停止") {
    // All hypothesis steps exhausted. In goal mode this is NOT necessarily a
    // real success — the Controller may have run out of steps without the goal
    // criterion firing — so we say so plainly instead of claiming "完成".
    state.run.note = state.goalMode ? "目标步骤已执行完毕（未观测到明确成功信号，请人工确认）" : "计划全部完成 ✅";
  } else if (!state.run.note) {
    state.run.note = "已停止";
  }
  // Best path for the MD artifact: the verified sequential history.
  state.run.best = { score: 1, steps: state.history.length, history: state.history };
  persistState();
  if (state.workingTabId) { try { await observeRetry(state.workingTabId, 4, 600); } catch { /* keep old snapshot */ } }
  persistState();
}

// ---------- MD packaging ----------
function buildMarkdown() {
  if (!state.plan) return "# 尚未生成计划\n";
  const lines = [];
  lines.push(`# 网页自动化最佳路线`);
  lines.push("");
  lines.push(`- 生成时间: ${new Date().toISOString()}`);
  lines.push(`- 站点入口: ${state.plan.entryUrl || "(见步骤)"}`);
  lines.push(`- 决策模型: ${state.run?.provider || state.lastProvider || state.model.pref}`);
  lines.push(`- 计划解析: ${state.lastPlanSource}`);
  lines.push("");
  lines.push(`## 步骤计划`);
  state.plan.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.intent}${s.url ? ` (${s.url})` : ""}`);
  });
  lines.push("");

  const best = state.run?.best;
  if (best) {
    lines.push(`## 最佳路线（顺序执行验证通过，共 ${best.history.length} 步）`);
    best.history.forEach((h, i) => {
      lines.push(`### 步骤 ${i + 1}: ${h.intent}`);
      lines.push(`- 动作: ${h.kind} · ${h.label}`);
      lines.push(`- 校验: ${h.verify}`);
      lines.push("");
    });
    lines.push(`### 重放定位器`);
    lines.push(`最佳路径共 ${best.history.length} 步，各步候选元素的作用域内 durable locator 见下方历史记录。`);
    lines.push("");
  }
  if (state.history.length) {
    lines.push(`## 手动执行历史`);
    state.history.forEach((h, i) => {
      const loc = h.action?.locator;
      const strat = loc?.strategies?.[0];
      lines.push(`### 步骤 ${i + 1}: ${h.intent}`);
      lines.push(`- 动作: ${h.action?.kind} ${h.action?.label || ""}`);
      lines.push(`- 首选定位器: ${strat ? strat.type + " " + (strat.selector || strat.name || "") : "(无)"}`);
      lines.push(`- 作用域: ${loc?.scope || "(主文档)"}`);
      lines.push(`- 校验: ${h.verify || "-"}`);
      lines.push("");
    });
  }
  lines.push(`## 各步决策与兜底`);
  lines.push(`每步先由 jev 判定元素树（决策: ${state.run?.provider || "—"}），无可用候选或校验失败时回退至 LLM，最后回退至 browser-use agentic 兜底。`);
  (state.plan?.steps || []).forEach((s, i) => {
    if (s.decision) {
      lines.push(`- 步骤 ${i + 1} [${s.status}] 决策: ${s.decision.provider || "—"} · ${s.note || ""}`);
    }
  });
  lines.push("");
  lines.push(`> 本文件供 Agent 直接消费，复现即可执行；元素定位采用 durable locator，页面改版后由重解析兜底。`);
  return lines.join("\n");
}

// ---------- jev connection test ----------
// A tiny synthetic page with a few candidate elements, so we can exercise the
// configured jev endpoint (reachability + response parsing) without a live tab.
function jevTestState() {
  const act = (id, kind, role, label) => ({
    id, kind, role, label, node: id, attrs: {},
    locator: { scope: "(主文档)", strategies: [{ type: "css", selector: "#" + id }] },
  });
  return {
    url: "https://example.com/jev-test",
    title: "jev 连接测试",
    text: "搜索框 搜索按钮 第一条结果 提交",
    actions: [
      act("i1", "fill", "textbox", "搜索框"),
      act("b1", "click", "button", "搜索"),
      act("r1", "click", "link", "第一条结果"),
      act("s1", "click", "button", "提交"),
    ],
  };
}

// ---------- message router ----------
function publicState() {
  return {
    workingTabId: state.workingTabId,
    plan: state.plan,
    stepIndex: state.stepIndex,
    lastState: state.lastState,
    routes: state.routes,
    history: state.history,
    model: state.model,
    user: state.user,
    lastPlanSource: state.lastPlanSource,
    lastProvider: state.lastProvider,
    lastErrors: state.lastErrors,
    goal: state.goal,
    goalMode: state.goalMode,
    subGoalIdx: state.subGoalIdx,
    stepSnaps: state.stepSnaps || {},
    routesMeta: state.routesMeta,
    runLog: (state.runLog || []).slice(-400),
    runLogRev: state.runLogRev || 0,
    config: {
      typesafeModel: config.typesafeModel,
      typesafeEndpoint: config.typesafeEndpoint,
      jevAdapter: config.jevAdapter,
      deepseekBase: config.deepseekBase,
      deepseekModel: config.deepseekModel,
      vision: config.vision,
      visionBase: config.visionBase,
      visionModel: config.visionModel,
      browserUseUrl: config.browserUseUrl,
      routeOn: config.routeOn,
      routeTopBar: config.routeTopBar,
      probeOn: config.probeOn,
      probeLockBar: config.probeLockBar,
      sweepStrategy: config.sweepStrategy || "onDemand",
      sweepMaxSteps: config.sweepMaxSteps || 6,
      sweepStepRatio: config.sweepStepRatio || 0.8,
      hasTypesafeKey: !!config.typesafeKey,
      hasDeepseekKey: !!config.deepseekKey,
      hasVisionKey: !!(config.visionKey || config.deepseekKey),
      // v0.5 模型渠道：渠道显示名覆盖 + 各渠道模型清单
      channelNames: config.channelNames || {},
      jevModels: config.jevModels || [],
      dsModels: config.dsModels || [],
      visModels: config.visModels || [],
      channels: config.channels || [],
    },
    run: state.run
      ? {
          running: state.run.running,
          mode: state.run.mode,
          width: state.run.width,
          round: state.run.round,
          stepIndex: state.run.stepIndex,
          provider: state.run.provider,
          note: state.run.note,
          waiting: state.run.waiting || null,
          confirmMode: !!state.run.confirmMode,
          best: state.run.best
            ? { score: state.run.best.score, steps: state.run.best.history.length, history: state.run.best.history }
            : null,
          downloadFired: !!state.run.downloadFired,
          stagnantStreak: state.run.stagnantStreak || 0,
          repeatActionStreak: state.run.repeatActionStreak || 0,
          goalAchieved: !!state.run.goalAchieved,
          lastProbe: state.run.lastProbe || null,
          probeHint: state.run.probeHint || null,
          askHuman: !!(state.run.waiting && state.run.waiting.askHuman),
        }
      : null,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !msg.type) return false;
  const handle = async () => {
    await stateReady; // restore persisted state before acting (worker restart)
    switch (msg.type) {
      case "GET_STATE":
        return { ok: true, state: publicState() };

      case "SET_CONFIG": {
        const allowed = Object.keys(DEFAULT_CONFIG);
        for (const k of allowed) if (k in (msg.config || {})) config[k] = msg.config[k];
        await chrome.storage.local.set({ config });
        return { ok: true, state: publicState() };
      }

      case "SET_PROVIDER":
        state.model.pref = ["auto", "jev", "deepseek", "mock"].includes(msg.pref) ? msg.pref : "auto";
        return { ok: true, state: publicState() };

      case "USER_INFO":
        state.user = { ...state.user, ...(msg.user || {}) };
        return { ok: true, state: publicState() };

      case "SET_PLAN": {
        state.runLog = []; // 新的一次测试：日志从头记录
        logLine("用户", msg.text);
        let plan;
        try {
          plan = await buildPlan(msg.text);
        } catch (e) {
          const why = e && e.message ? e.message : String(e);
          logLine("系统", "✗ 计划生成失败：" + why);
          return { ok: false, reason: why };
        }
        if (!plan.steps.length) { logLine("系统", "✗ 计划解析失败：无法解析出步骤"); return { ok: false, reason: "无法解析出步骤" }; }
        state.plan = plan;
        // 模式合一：即使是「启动执行」，也构造 goal + successCriteria 并开启目标驱动
        // 引擎，让末尾 LLM 完成裁判 / replan 展开 / Route 补全全部生效（不再有"顺序模式"）。
        state.goal = {
          goal: msg.text,
          subGoals: plan.steps.map((s) => ({ noun: s.target || s.intent || "", kind: "click" })),
          successCriteria: inferSuccess(msg.text),
        };
        state.goalMode = true;
        state.stepIndex = 0;
        state.history = [];
        state.routes = [];
        state.stepSnaps = {};
        state.routesMeta = null;
        state.run = null;
        // Per-step state machine: pending → observing → judging → executing →
        // verifying → done / fallback / error. The panel reads this to show
        // exactly which step is in which phase.
        for (const s of plan.steps) {
          s.status = "pending";
          s.decision = null;
          s.note = "";
        }
        const tab = await activeTab();
        if (plan.entryUrl) {
          const host = plan.entryUrl.replace(/^https?:\/\//, "").split("/")[0];
          const existing = await new Promise((r) =>
            chrome.tabs.query({}, (ts) => r(ts.find((t) => t.url && t.url.includes(host))))
          );
          if (existing) state.workingTabId = existing.id;
          else {
            const created = await new Promise((r) => chrome.tabs.create({ url: plan.entryUrl }, (t) => r(t)));
            state.workingTabId = created.id;
            await sleep(1500);
          }
        } else if (tab) {
          state.workingTabId = tab.id;
        }
        await observeRetry(state.workingTabId);
        // If the browser is already where the leading navigate steps want us,
        // mark them done instead of asking the decider to "click" our way there.
        state.stepIndex = skipSatisfied(state.plan.steps, state.stepIndex, state.lastState?.url || "");
        // observeRetry tagged the snapshot with the PRE-skip index (e.g. 步骤1).
        // The page is already where the skipped steps wanted us, so re-tag the
        // same snapshot for the post-skip step too — otherwise that step's tab
        // falls back to a records-only list (just the 3 live candidates).
        if (state.stepIndex > 0) saveStepSnap(state.stepIndex, state.lastState);
        await computeRoutes();
        persistState();
        return { ok: true, state: publicState() };
      }

      case "SET_GOAL": {
        // Agentic mode: one short sentence -> objective (sub-goals + success
        // criteria). The Controller (LLM) discovers the unknown middle
        // navigation at run time; the fast Actor (Jev) owns the hot path.
        state.runLog = []; // 新的一次测试：日志从头记录
        logLine("用户", msg.text);
        const g = await parseGoal(msg.text, config);
        if (!g.subGoals.length) {
          logLine("系统", "✗ 目标解析失败：无法提取子目标");
          return { ok: false, reason: "无法从目标中提取子目标" };
        }
        logLines("LLM", `目标解析（${g.subGoals.length} 个子目标）`, [
          ...g.subGoals.map((s, i) => {
            const v = s.verb && s.verb !== "click" ? ` [${s.verb}]` : "";
            const val = s.value ? `「${s.value}」` : "";
            return `${i + 1}. ${v ? v.replace("[", "").replace("]", "") + " " : ""}${s.noun}${val}`;
          }),
          `完成判定: ${g.successCriteria?.signal || "-"}${g.successCriteria?.note ? `（${g.successCriteria.note}）` : ""}`,
        ]);
        state.goal = g;
        state.goalMode = true;
        state.subGoalIdx = 0;
        state.controllerHistory = [];
        // The hypothesis step list lets the existing sequential engine run today;
        // the Controller is free to deviate/extend it via the goal context.
        state.plan = { steps: g.steps || [], entryUrl: "" };
        state.stepIndex = 0;
        state.history = [];
        state.routes = [];
        state.stepSnaps = {};
        state.routesMeta = null;
        state.run = null;
        for (const s of state.plan.steps) {
          s.status = "pending";
          s.decision = null;
          s.note = "";
        }
        const tab = await activeTab();
        if (tab) state.workingTabId = tab.id;
        await observeRetry(state.workingTabId);
        await computeRoutes();
        persistState();
        return { ok: true, state: publicState() };
      }

      case "OBSERVE": {
        if (!state.workingTabId) {
          const tab = await activeTab();
          state.workingTabId = tab?.id || null;
        }
        const res = await observeRetry(state.workingTabId);
        await computeRoutes();
        persistState();
        return { ok: res?.ok !== false, state: publicState(), observe: res };
      }

      case "STEP": {
        const res = await doStep(msg.action);
        persistState();
        return { ok: res.ok, state: publicState(), result: res };
      }

      case "BEAM_START": {
        if (!state.plan || !state.plan.steps.length)
          return { ok: false, reason: "请先在 Agent 里描述自动化步骤", state: publicState() };
        // Fire-and-forget: runPlan must NOT be awaited here — awaiting it
        // blocks this response until the whole run finishes, so the panel
        // renders nothing until the user clicks 停止. Return immediately;
        // the panel polls GET_STATE for live progress.
        runPlan(msg.k, msg.confirm).catch((e) => {
          if (state.run) {
            state.run.running = false;
            state.run.note = "探索异常: " + (e?.message || e);
          }
        });
        return { ok: true, state: publicState() };
      }

      case "BEAM_STOP":
        logLine("用户", "请求停止执行");
        if (state.run) {
          state.run.running = false;
          state.run.waiting = null;
          state.run.note = "用户已停止";
        }
        persistState();
        return { ok: true, state: publicState() };

      // Step-by-step confirm mode: execute the step that was paused for
      // confirmation. Fire-and-forget so the panel keeps polling live.
      case "RUN_APPROVE": {
        if (!state.run?.running) return { ok: false, reason: "没有进行中的探索", state: publicState() };
        const w = state.run.waiting;
        if (!w) return { ok: true, state: publicState() };
        logLine("用户", `确认执行第 ${w.stepIndex + 1} 步`);
        state.run.waiting = null;
        state.run.note = "";
        state.run.resumeIdx = w.stepIndex; // pass the confirm gate for THIS step only
        const st = state.plan.steps[w.stepIndex];
        if (st) { st.status = "executing"; st.note = ""; }
        runLoop().catch((e) => {
          if (state.run) { state.run.running = false; state.run.note = "探索异常: " + (e?.message || e); }
        });
        return { ok: true, state: publicState() };
      }

      case "RUN_SKIP": {
        const w = state.run?.waiting;
        if (!w) return { ok: false, reason: "当前没有等待确认的步骤", state: publicState() };
        const st = state.plan.steps[w.stepIndex];
        if (st) { st.status = "skipped"; st.note = "用户跳过"; delete st._prep; }
        logLine("用户", `跳过第 ${w.stepIndex + 1} 步`);
        state.run.waiting = null;
        state.run.note = "";
        state.stepIndex = w.stepIndex + 1; // next step re-enters the confirm gate
        runLoop().catch((e) => {
          if (state.run) { state.run.running = false; state.run.note = "探索异常: " + (e?.message || e); }
        });
        return { ok: true, state: publicState() };
      }

      // Phase 3: the human resolved a stuck spot (e.g. logged in / switched org)
      // and wants the run to continue from the current step with a clean slate.
      case "GOAL_RESUME": {
        if (!state.run) return { ok: false, reason: "没有待确认的目标", state: publicState() };
        if (!state.run.waiting?.askHuman) return { ok: false, reason: "当前没有待人工确认的目标", state: publicState() };
        logLine("用户", "已人工处理，继续执行");
        state.run.waiting = null;
        state.run.note = "";
        state.run.running = true;
        // Reset the governance streaks so the human's action counts as progress
        // and the run gets a fresh chance instead of re-triggering the guard.
        state.run.stagnantStreak = 0;
        state.run.repeatActionStreak = 0;
        state.run.lastPageSig = null;
        state.run.lastAction = null;
        runLoop().catch((e) => {
          if (state.run) { state.run.running = false; state.run.note = "探索异常: " + (e?.message || e); }
        });
        return { ok: true, state: publicState() };
      }

      case "BUILD_MD":
        return { ok: true, md: buildMarkdown() };

      case "CLEAR_LOG":
        state.runLog = [];
        state.runLogRev = (state.runLogRev || 0) + 1;
        persistState();
        return { ok: true, state: publicState() };

      case "LIST_MODELS": {
        // 模型渠道编辑弹窗的「拉取模型列表」：GET 上游 OpenAI 兼容 /models。
        // base/key 优先取面板传来的值（用户正在编辑），留空则回退到已保存配置。
        const ch = msg.channel;
        const baseOf = (c) =>
          c === "jev" ? config.typesafeEndpoint
          : c === "ds" ? config.deepseekBase
          : c === "vis" ? config.visionBase
          : c === "bu" ? config.browserUseUrl
          : "";
        const keyOf = (c) =>
          c === "jev" ? config.typesafeKey
          : c === "ds" ? config.deepseekKey
          : c === "vis" ? config.visionKey
          : "";
        let base = (msg.base || "").trim() || (baseOf(ch) || "").trim();
        base = base.replace(/\/+$/, "");
        const key = (msg.key || "").trim() || (keyOf(ch) || "").trim();
        if (!base) return { ok: false, reason: "请先填写接口地址" };
        const url = /\/models$/.test(base) ? base : base + "/models";
        try {
          const r = await fetch(url, { headers: key ? { Authorization: "Bearer " + key } : {} });
          if (!r.ok) return { ok: false, reason: `HTTP ${r.status}（上游可能不提供 /models 列表接口）` };
          const j = await r.json();
          const raw = j.data || j.models || [];
          const models = raw.map((m) => (typeof m === "string" ? m : m.id || m.name || m.model)).filter(Boolean);
          return { ok: true, models, url };
        } catch (e) {
          return { ok: false, reason: (e && e.message) || String(e) };
        }
      }

      case "JEV_TEST": {
        if (!config.typesafeKey) return { ok: false, reason: "未配置 jev API Key（在设置页填写）" };
        const adapter = config.jevAdapter === "openai" ? "openai" : "typesafe";
        if (adapter === "openai" && !config.typesafeEndpoint)
          return { ok: false, reason: "OpenAI 兼容模式需要填写端点 URL" };
        const started = Date.now();
        try {
          const r = await decideTopK(jevTestState(), "在搜索框输入并点击搜索按钮", 3, config, "jev", []);
          return {
            ok: true,
            adapter,
            provider: r.provider,
            latencyMs: r.latencyMs,
            sample: (r.routes || []).slice(0, 3).map((x) => ({
              label: x.action?.label || x.action?.role || "?",
              score: x.score,
            })),
            errors: r.errors,
          };
        } catch (e) {
          return { ok: false, reason: e.message, latencyMs: Date.now() - started };
        }
      }

      default:
        return { ok: false, reason: "unknown type " + msg.type };
    }
  };

  handle().then(respond).catch((e) => respond({ ok: false, reason: String(e) }));
  return true; // async respond
});

// Open side panel when the toolbar icon is clicked.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
