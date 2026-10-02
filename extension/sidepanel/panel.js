// panel.js — side panel UI controller. Talks to background.js via chrome.runtime.

const $ = (id) => document.getElementById(id);
const sendMsg = (msg) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(msg, (res) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    resolve(res);
  });
});

let current = null; // last public state
let pollTimer = null;

// ---- tab switching ----
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".pane").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $(t.dataset.tab).classList.add("active");
  })
);

// ---- Agent ----
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  $("chat").appendChild(div);
  $("chat").scrollTop = $("chat").scrollHeight;
}

$("modelSelect").addEventListener("change", (e) => {
  sendMsg({ type: "SET_PROVIDER", pref: e.target.value }).catch(() => {});
});

// ---- Agent composer ----
// 发送即目标：一句话描述最终结果 -> SET_GOAL（agentic 模式），由 Agent 拆解子目标
// 并自动探索执行。Enter 发送、Shift+Enter 换行；isComposing 守卫避免中文输入法
// 的确认回车误触发发送。
function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 96) + "px";
}

async function sendCurrent() {
  const text = $("chatInput").value.trim();
  if (!text) return;
  $("chatInput").value = "";
  autoGrow($("chatInput"));
  addMsg("user", text);
  try {
    const res = await sendMsg({ type: "SET_GOAL", text });
    if (!res || !res.ok) { addMsg("agent", "目标解析失败：" + (res?.reason || "未知")); return; }
    const s = res.state;
    const sg = (s.goal?.subGoals || []).map((o) => o.noun).join(" → ");
    addMsg("agent", `🎯 已识别目标，拆出子目标：${sg}；完成判定：${signalLabel(s.goal?.successCriteria?.signal)}。到「工作台」点「启动探索」开始自动执行。`);
    document.querySelector('.tab[data-tab="workbench"]').click();
    renderState(s);
  } catch (e) {
    addMsg("agent", "错误：" + e.message);
  }
}

$("sendBtn").addEventListener("click", sendCurrent);
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendCurrent();
  }
});
$("chatInput").addEventListener("input", () => autoGrow($("chatInput")));

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function signalLabel(sig) {
  return ({ download: "触发下载", dialogClosed: "导出/弹窗已关闭", elementClicked: "目标元素已点击" }[sig]) || sig || "目标达成";
}

$("uploadBtn").addEventListener("click", () => $("uploadInput").click());
$("uploadInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  addMsg("user", "上传技能包：" + f.name);
  addMsg("agent", "技能包已接收，可作为步骤模板复用（MVP 仅记录文件名）。");
});

// ---- Workbench ----
$("observeBtn").addEventListener("click", async () => {
  $("observeBtn").textContent = "观察中…";
  try {
    const res = await sendMsg({ type: "OBSERVE" });
    if (res?.ok) renderState(res.state);
    else alert("观察失败：" + (res?.observe?.reason || "未知"));
  } finally {
    $("observeBtn").textContent = "观察当前标签";
  }
});

$("beamBtn").addEventListener("click", async () => {
  const k = parseInt($("exploreK").value, 10) || 3;
  $("beamBtn").disabled = true;
  try {
    const res = await sendMsg({ type: "BEAM_START", k, confirm: $("confirmMode")?.checked });
    if (res?.ok) {
      renderState(res.state);
      startPolling();
      addMsg("agent", `探索已启动（每步 K=${k}${$("confirmMode")?.checked ? " · 逐步确认模式" : ""}）：逐步 观察 → jev 判定 → 并行执行+校验取最优 → 通过后进入下一步。`);
    } else {
      alert("探索失败：" + (res?.reason || res?.state?.run?.note || "未知"));
      if (res?.state) renderState(res.state);
    }
  } finally {
    $("beamBtn").disabled = false;
  }
});

$("beamStopBtn").addEventListener("click", async () => {
  await sendMsg({ type: "BEAM_STOP" });
  addMsg("agent", "已请求停止，等待当前动作收尾。");
});

$("buildMdBtn").addEventListener("click", async () => {
  const res = await sendMsg({ type: "BUILD_MD" });
  $("mdView").value = res?.md || "";
});

$("copyMdBtn").addEventListener("click", () => {
  navigator.clipboard.writeText($("mdView").value).then(() => alert("已复制 MD"));
});

$("downloadMdBtn").addEventListener("click", () => {
  const blob = new Blob([$("mdView").value], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "automation-plan.md";
  a.click();
});

$("testBtn").addEventListener("click", async () => {
  const res = await sendMsg({ type: "OBSERVE" });
  if (res?.ok) {
    const found = (current?.history || []).length + (current?.run?.best?.history || []).length;
    alert(`已重新观察工作标签（${res.state.lastState?.url}）。历史 ${found} 步将按 durable locator 重解析重放。`);
    renderState(res.state);
  }
});

// ---- polling while run executes ----
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const res = await sendMsg({ type: "GET_STATE" });
      if (res?.ok) {
        renderState(res.state);
        if (!res.state.run?.running) stopPolling();
      }
    } catch { /* ignore */ }
  }, 500);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function renderState(s) {
  current = s;
  if (!s) return;
  $("workingInfo").textContent = s.workingTabId ? `工作标签 #${s.workingTabId}` : "";
  renderGoal(s);
  renderPlan(s.plan, s.run);
  const cur = s.plan?.steps?.[s.run?.stepIndex ?? s.stepIndex];
  renderRoutes(s.routes, s.routesMeta, cur?.decision);
  renderTree(s);
  renderRun(s.run);
  renderRunLog(s);
  refreshMd(s);
}

// ---- 运行日志：原始日志流，`HH:MM:SS [标签] 文本` 一行一条，不做渲染加工 ----
// 仅在 runLogRev 变化时重绘（500ms 轮询下避免无谓 DOM 重建），并自动滚到底。
let logRev = -1;
function renderRunLog(s) {
  const rev = s.runLogRev || 0;
  if (rev === logRev) return;
  logRev = rev;
  const el = $("runLogView");
  if (!el) return;
  const lines = (s.runLog || []).map((l) => `${l.ts} [${l.tag}] ${l.text}`);
  el.textContent = lines.length ? lines.join("\n") : "（暂无日志。描述目标并启动执行后，这里会原样记录每一步交互）";
  el.scrollTop = el.scrollHeight;
}

$("copyLogBtn").addEventListener("click", () => {
  navigator.clipboard.writeText($("runLogView").textContent).then(() => alert("已复制运行日志"));
});
$("downloadLogBtn").addEventListener("click", () => {
  const blob = new Blob([$("runLogView").textContent], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "run-" + new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19) + ".log";
  a.click();
});
$("clearLogBtn").addEventListener("click", async () => {
  const res = await sendMsg({ type: "CLEAR_LOG" });
  if (res?.state) renderRunLog(res.state);
});

// Phase 4 — goal card: the one-line objective, its sub-goal progress (✅ reached
// / ▶ current / · pending) and the success signal that defines "done".
function renderGoal(s) {
  const card = $("goalCard");
  if (!card) return;
  if (!s.goalMode || !s.goal) { card.hidden = true; card.innerHTML = ""; return; }
  card.hidden = false;
  const g = s.goal;
  const sg = g.subGoals || [];
  const cur = s.subGoalIdx ?? 0;
  const chips = sg.length
    ? sg.map((o, i) => {
        const mark = i < cur ? "✅" : i === cur ? "▶" : "·";
        const cls = i < cur ? "reached" : i === cur ? "current" : "pending";
        const vb = o.verb && o.verb !== "click" ? `<b>${escapeHtml(o.verb)}</b> ` : "";
        return `<span class="gchip ${cls}">${mark} ${vb}${escapeHtml(o.noun)}${o.value ? `「${escapeHtml(o.value)}」` : ""}</span>`;
      }).join("")
    : `<span class="gchip pending">· 无显式子目标（由 Agent 直接探索）</span>`;
  const sc = g.successCriteria || {};
  card.innerHTML =
    `<div class="gtext">${escapeHtml(g.goal)}</div>` +
    `<div class="gchips">${chips}</div>` +
    `<div class="gmuted">完成判定：<b>${signalLabel(sc.signal)}</b> — ${escapeHtml(sc.note || "")}` +
    (s.run?.goalAchieved ? ` · <b class="gok">已达成 ✅</b>` : "") + `</div>`;
}

// Normalize a step into a human-readable label. The raw `intent` may keep the
// user's exact words ("搜搜星空灯"); the displayed plan should read as the
// action actually going to be performed.
function stepDisplay(st) {
  const t = st.target || "";
  const v = st.value || st.target || "";
  switch (st.verb) {
    case "navigate": return "打开 " + (t || st.url || "网页");
    case "fill": return "在输入框填入「" + v + "」";
    case "search": return "搜索「" + v + "」(填入并提交)";
    case "select": return "选择 " + (t || v);
    case "setDate": return "设置 " + (t || v) + " 为「" + (st.value || "") + "」";
    case "click":
    default: return "点击 " + (t || st.intent || "元素");
  }
}

const STEP_STATUS = {
  pending: { t: "待执行", c: "var(--muted)" },
  observing: { t: "观察中", c: "#0891b2" },
  judging: { t: "判定中", c: "#7c3aed" },
  executing: { t: "执行中", c: "#d97706" },
  verifying: { t: "校验中", c: "#d97706" },
  done: { t: "已完成", c: "#16a34a" },
  waiting: { t: "待确认", c: "#d97706" },
  skipped: { t: "已跳过", c: "#0891b2" },
  fallback: { t: "兜底(browser-use)", c: "#d97706" },
  error: { t: "失败", c: "#dc2626" },
};

function renderPlan(plan, run) {
  const ol = $("planList");
  ol.innerHTML = "";
  (plan?.steps || []).forEach((st, i) => {
    const li = document.createElement("li");
    const status = st.status || "pending";
    const meta = STEP_STATUS[status] || STEP_STATUS.pending;
    li.textContent = (i + 1) + ". " + stepDisplay(st);
    const badge = document.createElement("span");
    badge.className = "step-badge";
    badge.style.color = meta.c;
    badge.textContent = " · " + meta.t;
    li.appendChild(badge);
    if (status === "done") li.classList.add("done");
    else if (status === "error") li.style.color = "#dc2626";
    else if (status !== "pending") { li.style.color = meta.c; li.style.fontWeight = "600"; }
    // per-step decision + fallback note (the key to "为什么这步走偏")
    if (st.decision && status !== "done") {
      const d = document.createElement("div");
      d.className = "muted";
      d.style.fontSize = "11px";
      d.textContent =
        `决策: ${st.decision.provider || "?"} · ${(st.decision.candidates || []).length} 候选` +
        (st.note ? ` · ${st.note}` : "");
      li.appendChild(d);
    } else if (st.note && status === "done") {
      const d = document.createElement("div");
      d.className = "muted";
      d.style.fontSize = "11px";
      d.textContent = st.note;
      li.appendChild(d);
    }
    ol.appendChild(li);
  });
  // Surface the plan source so a failed LLM parse (and the reason) is visible
  // right here, not only in the chat log.
  const srcEl = $("planSource");
  if (srcEl) {
    const src = (current && current.lastPlanSource) || "";
    if (src) {
      const isFail = /失败/.test(src);
      srcEl.textContent = "计划来源: " + src;
      srcEl.style.color = isFail ? "#dc2626" : "var(--muted)";
    } else {
      srcEl.textContent = "";
    }
  }
}

function renderRoutes(routes, meta, stepDecision) {
  const box = $("routes");
  box.innerHTML = "";
  // Per-step decision: which provider judged this step and how many candidates
  // it produced. This is what answers "为什么这一步走偏" — and whether jev was
  // actually used or the chain fell back to llm/mock/browser-use.
  if (stepDecision) {
    const sd = document.createElement("div");
    sd.className = "muted";
    sd.style.marginBottom = "4px";
    const prov = stepDecision.provider || "?";
    sd.style.color =
      prov === "jev" ? "#16a34a" : prov === "mock" ? "#dc2626" : prov === "browser-use" ? "#d97706" : "var(--muted)";
    sd.textContent =
      `本步决策: ${prov} · ${(stepDecision.candidates || []).length} 个候选` +
      (stepDecision.note ? ` · ${stepDecision.note}` : "");
    box.appendChild(sd);
  }
  // Decision context: which provider decided, and how big the observed
  // snapshot was AT DECISION TIME. A tiny snapshot (half-loaded shell page)
  // explains poor candidates like "click 更多 16%" for a fill step.
  if (meta && (meta.provider || meta.errors?.length)) {
    const head = document.createElement("div");
    head.className = "muted";
    head.style.marginBottom = "4px";
    const badSnap = meta.snapCount != null && meta.snapCount < 6;
    head.textContent =
      `决策: ${meta.provider || "?"}` +
      (meta.snapCount != null ? ` · 决策时快照 ${meta.snapCount} 个元素` : "") +
      (badSnap ? " ⚠️快照过小（页面可能未加载完），点「观察当前标签」重试" : "");
    head.style.color = badSnap ? "#d97706" : "var(--muted)";
    box.appendChild(head);
    if (meta.errors?.length && meta.provider !== "jev") {
      const err = document.createElement("div");
      err.className = "muted";
      err.style.color = "#dc2626";
      err.style.marginBottom = "4px";
      err.textContent = "⚠ " + meta.errors.join("；");
      box.appendChild(err);
    }
  }
  (routes || []).forEach((r) => {
    const div = document.createElement("div");
    div.className = "route";
    const strat = r.action?.locator?.strategies?.[0];
    const p = Math.round((r.score || 0) * 100);
    div.innerHTML =
      `<span class="score">p ${p}%</span>` +
      `<div class="rk">${r.action?.kind} · ${r.action?.label || "(无标签)"}${r.tie > 1 ? ` <span class="muted">同名×${r.tie}</span>` : ""}</div>` +
      `<div class="strat">${strat ? strat.type + " " + (strat.selector || strat.name || "") : ""}</div>`;
    div.addEventListener("click", async () => {
      showLocator(`候选：${r.action?.label || "(无标签)"}`, r.action?.locator);
      const res = await sendMsg({ type: "STEP", action: r.action });
      if (res?.ok) { renderState(res.state); addMsg?.("agent", `执行步骤：${r.action?.label} → ${res.result?.verify || ""}`); }
      else alert("执行失败：" + (res?.reason || ""));
    });
    box.appendChild(div);
  });
  if (!(routes || []).length) box.innerHTML = `<div class="muted">（无候选）</div>`;
}

// ---- element tree: tab 0 = live page (by scope), tab 1..N = per plan step ----
let treeTab = null; // null = auto (furthest step with records)
let treeTabKey = "";

function showLocator(title, loc) {
  $("locatorView").textContent =
    "# " + title + "\n" + (loc ? JSON.stringify(loc, null, 2) : "（该记录未保存定位器）");
}

function renderTree(s) {
  const box = $("elementTree");
  box.innerHTML = "";
  const planSteps = s.plan?.steps || [];

  // Per-step candidate tags come from each step's decision (jev/llm/browser-use
  // produced these). This is what lets the per-step tab highlight which elements
  // were the decider's candidates for THAT step.
  const stepTags = planSteps.map((st) =>
    (st.decision?.candidates || []).map((c) => ({ kind: c.kind, label: c.label, tag: "候选" }))
  );

  // reset tab selection when the plan changes; auto = furthest step w/ records
  const planKey = planSteps.map((st) => st.intent).join("|");
  if (planKey !== treeTabKey) { treeTabKey = planKey; treeTab = null; }
  const autoTab = () => {
    for (let i = stepTags.length - 1; i >= 0; i--) {
      if (stepTags[i].length || s.stepSnaps?.[i]?.actions?.length) return i + 1;
    }
    return 0;
  };
  const eff = treeTab == null ? autoTab() : treeTab;

  // tab bar
  const bar = document.createElement("div");
  bar.className = "tree-tabs";
  const mkTab = (label, idx, count) => {
    const b = document.createElement("button");
    b.className = "tree-tab" + (eff === idx ? " active" : "");
    b.textContent = count != null ? `${label} (${count})` : label;
    b.addEventListener("click", () => { treeTab = idx; renderTree(s); });
    bar.appendChild(b);
  };
  mkTab("页面元素", 0, null);
  planSteps.forEach((st, i) => {
    const cnt = s.stepSnaps?.[i]?.actions?.length || stepTags[i].length || null;
    mkTab(`步骤${i + 1}`, i + 1, cnt);
  });
  box.appendChild(bar);

  const content = document.createElement("div");
  box.appendChild(content);

  if (eff === 0) {
    // live page snapshot grouped by scope (original behaviour)
    const snap = s.lastState;
    if (!snap || !snap.actions) {
      content.textContent = "（先点「观察当前标签」）";
      return;
    }
    // Label WHERE the snapshot came from — a stale snapshot of another tab
    // (e.g. a closed beam fork) is otherwise indistinguishable from the page
    // currently on screen.
    const head = document.createElement("div");
    head.className = "scope";
    head.textContent = `快照: ${(snap.title || "").slice(0, 24) || "(未知页面)"} · ${(snap.url || "").slice(0, 48)} · ${snap.actions.length} 个元素`;
    content.appendChild(head);
    const groups = {};
    for (const a of snap.actions) {
      const key = a.scope || "(主文档)";
      (groups[key] = groups[key] || []).push(a);
    }
    for (const [scope, acts] of Object.entries(groups)) {
      const h = document.createElement("div");
      h.className = "scope";
      const cls = scope.includes("shadow") ? "shadow" : scope.startsWith("iframe") ? "iframe" : "main";
      h.innerHTML = `<span class="badge ${cls}">${cls}</span>${scope} (${acts.length})`;
      content.appendChild(h);
      acts.slice(0, 30).forEach((a) => {
        const el = document.createElement("div");
        el.className = "el";
        el.textContent = `${a.kind} · ${a.label || a.role}${a.disabled ? "（禁用）" : ""}`;
        el.addEventListener("click", () => showLocator(a.label || a.role, a.locator));
        content.appendChild(el);
      });
    }
    return;
  }

  // per-step view: prefer the FULL snapshot observed at that step (stored by the
  // sequential engine keyed on step index), marking which elements were the
  // decided candidates. Only fall back to the candidate list when no snapshot
  // was captured (e.g. a step that failed before observing).
  const snap = s.stepSnaps?.[eff - 1];
  const entries = stepTags[eff - 1] || [];
  if (snap && snap.actions?.length) {
    const head = document.createElement("div");
    head.className = "scope";
    head.textContent = `该步观察快照: ${(snap.title || "").slice(0, 24) || "(未知页面)"} · ${(snap.url || "").slice(0, 48)} · ${snap.actions.length} 个元素`;
    content.appendChild(head);
    // tag lookup: kind|label -> tags from executed/decided records
    const tagMap = new Map();
    for (const e of entries) {
      const key = (e.kind || "") + "|" + (e.label || "");
      if (!tagMap.has(key)) tagMap.set(key, []);
      tagMap.get(key).push(e.tag || e.kind);
    }
    snap.actions.forEach((a) => {
      const el = document.createElement("div");
      el.className = "el";
      const tags = tagMap.get((a.kind || "") + "|" + (a.label || ""));
      const tag = tags ? tags[0] : "";
      el.innerHTML =
        (tag ? `<span class="badge ${tag === "候选" ? "main" : "shadow"}">${tag}</span> ` : "") +
        `${a.kind} · ${a.label || a.role || "(无标签)"}${a.disabled ? "（禁用）" : ""}`;
      el.addEventListener("click", () => showLocator(`步骤${eff}：${a.label || a.role || "(无标签)"}`, a.locator));
      content.appendChild(el);
    });
    // executed records that no longer match any snapshot element (e.g. the
    // element disappeared after the action) are still listed at the bottom
    const matched = new Set([...tagMap.keys()].filter((k) =>
      snap.actions.some((a) => (a.kind || "") + "|" + (a.label || "") === k)
    ));
    const orphans = entries.filter((e) => !matched.has((e.kind || "") + "|" + (e.label || "")));
    if (orphans.length) {
      const h = document.createElement("div");
      h.className = "scope";
      h.textContent = "动作记录（快照中已无对应元素）";
      content.appendChild(h);
      orphans.forEach((e) => {
        const el = document.createElement("div");
        el.className = "el";
        el.innerHTML = `<span class="badge main">${e.tag || e.kind}</span> ${e.kind} · ${e.label || "(无标签)"}` +
          (e.verify ? ` <span class="muted">${e.verify}</span>` : "");
        el.addEventListener("click", () => showLocator(`步骤${eff}：${e.label || "(无标签)"}`, e.locator));
        content.appendChild(el);
      });
    }
    return;
  }
  if (!entries.length) {
    content.innerHTML = `<div class="muted">（该步骤暂无动作记录）</div>`;
    return;
  }
  entries.slice(0, 50).forEach((e) => {
    const el = document.createElement("div");
    el.className = "el";
    const ok = /PASS/.test(e.verify || "");
    const bad = /FAIL/.test(e.verify || "");
    el.innerHTML =
      `<span class="badge ${e.tag === "候选" ? "main" : ok ? "shadow" : bad ? "iframe" : "main"}">${e.tag || e.kind}</span>` +
      `${e.kind} · ${e.label || "(无标签)"}` +
      (e.verify ? ` <span class="muted">${e.verify}</span>` : "") +
      (e.tag && e.tag !== "候选" ? ` <span class="muted">${e.tag}</span>` : "");
    el.addEventListener("click", () => showLocator(`步骤${eff}：${e.label || "(无标签)"}`, e.locator));
    content.appendChild(el);
  });
}

function renderRun(run) {
  const box = $("beamList");
  const status = $("beamStatus");
  // While paused for confirmation, KEEP the existing confirm-card DOM — the
  // 900ms poll rebuilds innerHTML otherwise, which can swallow a click.
  if (run?.waiting && box.dataset.waitKey === "w" + run.waiting.stepIndex) {
    status.textContent =
      `⏸ 等待确认 · 第 ${(run.waiting.stepIndex || 0) + 1} 步 · 决策: ${run.provider || "?"}` +
      (run.note ? ` · ${run.note}` : "");
    return;
  }
  box.dataset.waitKey = run?.waiting ? "w" + run.waiting.stepIndex : "";
  box.innerHTML = "";
  if (!run) {
    status.textContent = "（未启动。先在 Agent 描述步骤，再点「启动探索」）";
    return;
  }
  status.textContent =
    `${run.running ? "▶ 运行中" : "■ 已结束"} · 轮次 ${run.round} · 当前步 ${run.stepIndex + 1} · 决策: ${run.provider || "?"}` +
    (run.note ? ` · ${run.note}` : "");

  // ---- execution trail: 第1步 xxx 通过 > 第2步 xxx 通过 > 第n步 xxx 未通过 ----
  // The verified-good prefix and the exact failing element, at a glance.
  if (run.trail && run.trail.length) {
    const div = document.createElement("div");
    div.className = "exp";
    div.style.borderColor = run.trail[run.trail.length - 1].ok ? "#16a34a" : "#dc2626";
    div.innerHTML = `<b>轨迹</b><br><span class="strat">${run.trail
      .map((t) => `第${t.n}步 ${t.label || "?"}${t.ok ? " ✅通过" : " ❌未通过"}`)
      .join(" &gt; ")}</span>`;
    box.appendChild(div);
  }

  // ---- Phase 3: ask-human card (goal-mode stuck) ----
  // The loop-governance guard halted because the page stopped advancing. Instead
  // of spinning forever it surfaces this card so the human can intervene.
  if (run.waiting?.askHuman) {
    const div = document.createElement("div");
    div.className = "exp";
    div.style.borderColor = "#dc2626";
    div.innerHTML = `<b>🛑 需要人工确认</b><br><span class="strat">${escapeHtml(run.waiting.question || "")}</span>`;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;margin-top:6px";
    const mkBtn = (label, color, type) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = `background:${color};color:#fff;border:none;border-radius:6px;padding:4px 12px;cursor:pointer`;
      b.addEventListener("click", async () => {
        const res = await sendMsg({ type });
        if (res?.state) renderState(res.state);
        if (res?.ok && res.state?.run?.running) startPolling();
      });
      return b;
    };
    row.append(mkBtn("✓ 我已处理，继续", "#16a34a", "GOAL_RESUME"), mkBtn("✕ 放弃", "#dc2626", "BEAM_STOP"));
    div.appendChild(row);
    box.appendChild(div);
  }
  // ---- confirm card (step-by-step debug mode) ----
  else if (run.waiting) {
    const st = current?.plan?.steps?.[run.waiting.stepIndex];
    const dec = st?.decision;
    const div = document.createElement("div");
    div.className = "exp";
    div.style.borderColor = "#d97706";
    let html = `<b>⏸ 待确认 · 第 ${(run.waiting.stepIndex || 0) + 1} 步</b> · ${stepDisplay(st || {})}` +
      `<br><span class="strat">决策: ${dec?.provider || "?"}${dec?.note ? " · " + dec.note : ""}</span>`;
    (dec?.candidates || []).slice(0, run.width || 3).forEach((c, i) => {
      html += `<br><span class="strat">${i === 0 ? "★ " : "　"}${c.kind} · ${c.label} · p ${(c.score * 100).toFixed(0)}%${c.tie > 1 ? ` · 同名×${c.tie}` : ""}</span>`;
    });
    if (!dec?.candidates?.length) html += `<br><span class="strat">（无候选，确认后将走 browser-use 兜底）</span>`;
    div.innerHTML = html;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;margin-top:6px";
    const mkBtn = (label, color, type) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = `background:${color};color:#fff;border:none;border-radius:6px;padding:4px 12px;cursor:pointer`;
      b.addEventListener("click", async () => {
        const res = await sendMsg({ type });
        if (res?.state) renderState(res.state);
        if (res?.ok && res.state?.run?.running) startPolling();
      });
      return b;
    };
    row.append(mkBtn("✓ 执行此步", "#16a34a", "RUN_APPROVE"), mkBtn("⏭ 跳过此步", "#6b7280", "RUN_SKIP"));
    div.appendChild(row);
    box.appendChild(div);
  }

  // Surface the step-level status so a "决策: deepseek" or "browser-use 兜底"
  // line is never a silent downgrade — exactly the question you asked earlier.
  if (run.note && /browser-use|兜底|失败|未通过|无候选/.test(run.note)) {
    const div = document.createElement("div");
    div.className = "exp";
    div.style.borderColor = "#d97706";
    div.innerHTML = `<b>⚠ 步骤状态</b><br><span class="strat">${run.note}</span>`;
    box.appendChild(div);
  }
  if (run.best) {
    const div = document.createElement("div");
    div.className = "exp";
    div.style.borderColor = "#16a34a";
    div.innerHTML = `<b>★ 最佳路径</b> · ${run.best.steps} 步（顺序执行验证通过）<br>` +
      (run.best.history || []).map((h, i) => `${i + 1}. ${h.action?.label || h.label || "?"} (${h.verify || ""})`).join("<br>");
    box.prepend(div);
  }
}

// ---- MD auto-refresh ----
// Regenerate the MD artifact whenever the plan or the run result changes and
// the run is not running; keyed cache keeps polling cheap.
let mdKey = "";
function refreshMd(s) {
  if (!s.plan || !s.plan.steps.length || s.run?.running) return;
  const key =
    s.plan.steps.map((x) => x.intent).join("|") +
    "#" + (s.run?.best ? s.run.best.steps : "none") +
    "#" + ((s.run?.stepIndex ?? 0));
  if (key === mdKey) return;
  mdKey = key;
  sendMsg({ type: "BUILD_MD" })
    .then((res) => { $("mdView").value = res?.md || ""; })
    .catch(() => {});
}

// ---- Settings: 子标签 ----
document.querySelectorAll(".subtab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".subtab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".subpane").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $("sub-" + t.dataset.sub).classList.add("active");
  })
);

function hostOf(u) {
  try { return new URL(u).host; } catch { return u || ""; }
}

// ============ 模型渠道：渠道列表 + 编辑弹窗 + 选择模型弹窗 ============
// 逻辑渠道 role: jev=JEV 决策引擎, ds=DeepSeek 路线裁判, vis=Vision 视觉兜底, bu=browser-use 兜底
const ROLE_META = {
  jev: { title: "JEV 决策引擎", sub: "网页自动化主判定模型（阿里云 decision-model-preview 等 SystemOne 兼容接口）" },
  ds:  { title: "DeepSeek 路线裁判", sub: "jev 卡住时升级判路线的 LLM（OpenAI 兼容）" },
  vis: { title: "Vision 视觉兜底", sub: "探针找不到目标时截图定位（OpenAI 兼容 vision）" },
  bu:  { title: "browser-use 兜底", sub: "难步骤委托真实 browser-use 后端（仅填地址，无 Key）" },
};

let channels = [];      // 当前渠道数组（含内置 4 渠道 + 用户自定义）
let editingIndex = -1;  // 正在编辑的渠道下标
let pickerTemp = [];    // 模型选择弹窗的临时选择 [{name, caps}]
let pickerFetched = []; // 拉取到的模型
let pickerExisting = []; // 编辑中渠道已有的模型
let pickerTab = "fetched";

// 从 background config 构建渠道数组（内置 4 渠道 + 用户自定义 channels）
function buildChannels(cfg) {
  cfg = cfg || {};
  const seed = {
    jev: { endpoint: cfg.typesafeEndpoint || "https://api.typesafe.ai/v1/systemone", key: cfg.typesafeKey || "", models: cfg.jevModels || [], proto: cfg.jevAdapter || "typesafe", hasKey: !!cfg.hasTypesafeKey },
    ds:  { endpoint: cfg.deepseekBase || "https://api.deepseek.com/v1", key: cfg.deepseekKey || "", models: cfg.dsModels || [], proto: "openai", hasKey: !!cfg.hasDeepseekKey },
    vis: { endpoint: cfg.visionBase || "", key: cfg.visionKey || "", models: cfg.visModels || [], proto: "openai", hasKey: !!cfg.hasVisionKey },
    bu:  { endpoint: cfg.browserUseUrl || "", key: "", models: [], proto: "", hasKey: false },
  };
  const arr = [];
  for (const role of ["jev", "ds", "vis", "bu"]) {
    const s = seed[role];
    arr.push({
      role,
      name: (cfg.channelNames && cfg.channelNames[role]) || ROLE_META[role].title,
      proto: s.proto,
      endpoint: s.endpoint,
      key: s.key,
      models: s.models,
      hasKey: s.hasKey,
    });
  }
  if (Array.isArray(cfg.channels)) for (const c of cfg.channels) arr.push({ ...c, role: c.role || "" });
  return arr;
}

function renderChannels() {
  const box = $("channelList");
  if (!box) return;
  box.innerHTML = "";
  if (!channels.length) { box.innerHTML = `<div class="muted">还没有渠道，点「＋ 新增渠道」添加。</div>`; return; }
  channels.forEach((c, i) => {
    const card = document.createElement("div");
    card.className = "ch-card";
    const roleMeta = c.role ? ROLE_META[c.role] : null;
    const sub = c.role && roleMeta ? roleMeta.sub
      : (c.endpoint ? hostOf(c.endpoint) : "未填接口地址");
    const modelCount = (c.models || []).length;
    const ok = c.endpoint && (c.role === "bu" ? true : !!c.hasKey);
    card.innerHTML =
      `<div class="ch-card-main">` +
        `<div class="ch-card-name">${escapeHtml(c.name)}</div>` +
        `<div class="ch-card-sub">${escapeHtml(sub)}${modelCount ? " · 模型 " + modelCount + " 个" : ""}</div>` +
      `</div>` +
      `<div class="ch-card-actions">` +
        `<span class="ch-badge ${ok ? "on" : "off"}">${ok ? "已配置" : "未配置"}</span>` +
        `<button class="btn-edit" data-i="${i}">编辑</button>` +
        (c.role ? "" : `<button class="btn-del" data-del="${i}">删除</button>`) +
      `</div>`;
    box.appendChild(card);
  });
  box.querySelectorAll(".btn-edit").forEach((b) =>
    b.addEventListener("click", () => openEditChannel(parseInt(b.dataset.i, 10))));
  box.querySelectorAll(".btn-del").forEach((b) =>
    b.addEventListener("click", () => {
      const i = parseInt(b.dataset.del, 10);
      if (confirm("确定删除渠道「" + channels[i].name + "」？")) { channels.splice(i, 1); renderChannels(); }
    }));
}

function openEditChannel(i) {
  editingIndex = i;
  const c = channels[i] || { name: "", proto: "openai", endpoint: "", key: "", models: [] };
  $("chName").value = c.name || "";
  $("chProto").value = c.proto || "openai";
  $("chEndpoint").value = c.endpoint || "";
  $("chKey").value = c.key || "";
  $("chKey").type = "password";
  $("chKeyEye").textContent = "👁";
  $("chKey").placeholder = c.hasKey ? "已配置（输入可更换）" : "sk-...";
  $("chTestResult").textContent = "";
  syncProtoHint();
  renderModelRows(c.models || []);
  $("chModal").hidden = false;
}

// 按协议提示端点语义：SystemOne 端点不是 OpenAI 形态（无 /models、无 /chat/completions），
// 避免用户点「测试连接 / 拉取模型列表」时被 HTTP 400 误导。
function syncProtoHint() {
  const sel = $("chProto"), ep = $("chEndpoint"), hint = $("chEndpointHint");
  if (!sel || !ep || !hint) return;
  if (sel.value === "typesafe") {
    ep.placeholder = "https://llm-xxxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone";
    hint.textContent =
      "SystemOne 兼容：整串地址即决策接口（POST {model,state,questions}），" +
      "它不提供 /models 与 /chat/completions，模型名请手动填写（如 decision-model-preview）。";
  } else {
    ep.placeholder = "https://api.openai.com/v1";
    hint.textContent = "OpenAI 兼容：测试连接会请求 {地址}/chat/completions；{地址}/models 用于拉取模型列表。";
  }
}

const CAPS = ["text", "image", "video", "audio"];
function renderModelRows(models) {
  const box = $("chModelRows");
  if (!box) return;
  box.innerHTML = "";
  if ($("chModelsSub")) $("chModelsSub").textContent = `已选 ${models.length} 个；为每个模型指定能力并可自定义调用脚本。`;
  if (!models.length) { box.innerHTML = `<div class="mr-empty">尚未选择模型，点「☰ 选择模型」添加。</div>`; return; }
  models.forEach((m, idx) => {
    const row = document.createElement("div");
    row.className = "model-row";
    const caps = m.caps || [];
    const capHtml = CAPS.map((cap) =>
      `<span class="cap ${caps.includes(cap) ? "on" : ""}" data-cap="${cap}" data-mi="${idx}">${cap}</span>`
    ).join("");
    row.innerHTML =
      `<span class="mr-name">${escapeHtml(m.name)}</span>` +
      `<span class="mr-caps">${capHtml}</span>` +
      `<button class="mr-del" data-mi="${idx}">✕</button>`;
    box.appendChild(row);
  });
  box.querySelectorAll(".cap").forEach((el) =>
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.mi, 10), cap = el.dataset.cap;
      const set = new Set(models[idx].caps || []);
      if (set.has(cap)) set.delete(cap); else set.add(cap);
      models[idx].caps = [...set];
      renderModelRows(models);
    }));
  box.querySelectorAll(".mr-del").forEach((el) =>
    el.addEventListener("click", () => { models.splice(parseInt(el.dataset.mi, 10), 1); renderModelRows(models); }));
}

function openModelPicker() {
  const c = channels[editingIndex] || { models: [] };
  pickerExisting = (c.models || []).map((m) => ({ ...m }));
  pickerFetched = [];
  pickerTemp = pickerExisting.map((m) => ({ ...m }));
  pickerTab = "fetched";
  $("mmSearch").value = "";
  $("mmManual").value = "";
  $("mmPullMsg").textContent = "";
  setMmTabs();
  renderMmList();
  $("modelModal").hidden = false;
}

function setMmTabs() {
  document.querySelectorAll(".mm-tab").forEach((t) => t.classList.toggle("active", t.dataset.mmtab === pickerTab));
  const ft = document.querySelector('.mm-tab[data-mmtab="fetched"]');
  if (ft) ft.textContent = `新获取的模型 (${pickerFetched.length})`;
  const et = document.querySelector('.mm-tab[data-mmtab="existing"]');
  if (et) et.textContent = `已有的模型 (${pickerExisting.length})`;
}

function mmListItems() {
  const q = ($("mmSearch").value || "").trim().toLowerCase();
  const list = pickerTab === "fetched" ? pickerFetched : pickerExisting;
  return list.filter((m) => !q || (m.name || "").toLowerCase().includes(q));
}
function mmIsSel(name) { return pickerTemp.some((m) => m.name === name); }

function renderMmList() {
  const box = $("mmList");
  if (!box) return;
  box.innerHTML = "";
  const items = mmListItems();
  const total = items.length;
  const sel = items.filter((m) => mmIsSel(m.name)).length;
  $("mmSelCount").textContent = sel;
  $("mmTotal").textContent = total;
  $("mmCount").textContent = `已选择 ${pickerTemp.length} / ${pickerFetched.length + pickerExisting.length}`;
  if (!items.length) {
    box.innerHTML = `<div class="muted" style="grid-column:1/3">（此列表为空，可手动增加或点「⟳ 拉取模型列表」）</div>`;
    return;
  }
  items.forEach((m) => {
    const item = document.createElement("div");
    item.className = "mm-item";
    const checked = mmIsSel(m.name);
    item.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}/> <span>${escapeHtml(m.name)}</span>`;
    item.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) { if (!mmIsSel(m.name)) pickerTemp.push({ name: m.name, caps: (pickerTemp.find((x) => x.name === m.name)?.caps) || [] }); }
      else pickerTemp = pickerTemp.filter((x) => x.name !== m.name);
      renderMmList();
    });
    box.appendChild(item);
  });
}

function primaryModel(models) {
  if (!models || !models.length) return "";
  const t = models.find((m) => (m.caps || []).includes("text"));
  return (t || models[0]).name;
}

// ============ 渠道保存 / 与引擎字段同步 ============
async function persistChannels() {
  const cfg = { channels: [] };
  const models = { jev: [], ds: [], vis: [] };
  const names = {};
  const legacy = {};
  for (const c of channels) {
    if (c.role === "jev") {
      legacy.typesafeKey = c.key || undefined;
      legacy.typesafeEndpoint = c.endpoint || undefined;
      legacy.jevAdapter = c.proto === "openai" ? "openai" : "typesafe";
      legacy.typesafeModel = primaryModel(c.models) || "decision-model-preview";
      names.jev = c.name; models.jev = c.models;
    } else if (c.role === "ds") {
      legacy.deepseekKey = c.key || undefined;
      legacy.deepseekBase = c.endpoint || undefined;
      legacy.deepseekModel = primaryModel(c.models) || "deepseek-chat";
      names.ds = c.name; models.ds = c.models;
    } else if (c.role === "vis") {
      legacy.visionKey = c.key || undefined;
      legacy.visionBase = c.endpoint || undefined;
      legacy.visionModel = primaryModel(c.models) || "";
      legacy.vision = !!(c.models && c.models.length);
      names.vis = c.name; models.vis = c.models;
    } else if (c.role === "bu") {
      legacy.browserUseUrl = c.endpoint || undefined;
      names.bu = c.name;
    } else {
      cfg.channels.push({ name: c.name, proto: c.proto, endpoint: c.endpoint, key: c.key, models: c.models });
    }
  }
  cfg.channelNames = names;
  cfg.jevModels = models.jev;
  cfg.dsModels = models.ds;
  cfg.visModels = models.vis;
  Object.assign(cfg, legacy);
  try {
    const res = await sendMsg({ type: "SET_CONFIG", config: cfg });
    if (res?.ok) {
      try { chrome.storage.local.get("config", (d) => { chrome.storage.local.set({ config: Object.assign({}, d.config || {}, cfg) }); }); } catch (_) {}
      alert("已保存渠道配置。");
    } else alert("保存失败");
  } catch (e) { alert("保存失败：" + e.message); }
}

function saveChannel() {
  const i = editingIndex;
  if (i < 0) return;
  const c = channels[i];
  c.name = $("chName").value.trim() || (c.role ? ROLE_META[c.role].title : "新渠道");
  c.proto = $("chProto").value;
  c.endpoint = $("chEndpoint").value.trim();
  c.key = $("chKey").value.trim();
  // c.models 已在弹窗内被模型行/选择弹窗就地修改
  $("chModal").hidden = true;
  renderChannels();
  persistChannels();
}

// ============ 事件绑定 ============
$("addChannelBtn").addEventListener("click", () => {
  channels.push({ role: "", name: "", proto: "openai", endpoint: "", key: "", models: [] });
  openEditChannel(channels.length - 1);
});
$("chPickModels").addEventListener("click", openModelPicker);
$("chProto").addEventListener("change", syncProtoHint);
$("chSave").addEventListener("click", saveChannel);
$("chCancel").addEventListener("click", () => { $("chModal").hidden = true; });
// 模型配置页级保存（与编辑弹窗内的单独保存并存；此处一次性保存全部渠道）
$("saveChannelsBtn").addEventListener("click", () => persistChannels());
$("chKeyEye").addEventListener("click", () => {
  const inp = $("chKey");
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  $("chKeyEye").textContent = show ? "🙈" : "👁";
});
$("chTestBtn").addEventListener("click", async () => {
  const el = $("chTestResult");
  el.textContent = "测试中…"; el.style.color = "";
  const c = channels[editingIndex] || {};
  const base = ($("chEndpoint").value || c.endpoint || "").trim();
  const key = ($("chKey").value || c.key || "").trim();
  const proto = $("chProto").value || c.proto || "typesafe";
  // browser-use 渠道无需接口地址/Key；其余渠道必须先有地址
  if (!base && c.role !== "bu") { el.style.color = "#dc2626"; el.textContent = "✗ 请先填写接口地址"; return; }
  try {
    // 按渠道协议走真实调用路径（SystemOne 端点用 POST 决策探针，不再是 GET /models）
    const res = await sendMsg({
      type: "TEST_CHANNEL",
      role: c.role || "", proto, base, key,
      models: c.models || [],
    });
    if (res?.ok) {
      el.style.color = "#16a34a";
      const s = (res.sample || []).map((x) => `${x.label}(${Math.round((x.score || 0) * 100)}%)`).join(", ");
      el.textContent =
        `✓ 连接成功 · ${res.detail || ""}` +
        (res.latencyMs ? ` · ${res.latencyMs}ms` : "") +
        (s ? ` · 候选: ${s}` : "");
    } else {
      el.style.color = "#dc2626";
      el.textContent = "✗ " + (res?.reason || "连接失败") + (res?.latencyMs ? ` · ${res.latencyMs}ms` : "");
    }
  } catch (e) { el.style.color = "#dc2626"; el.textContent = "✗ " + e.message; }
});
$("mmSearch").addEventListener("input", renderMmList);
$("mmAdd").addEventListener("click", () => {
  const name = ($("mmManual").value || "").trim();
  if (!name) return;
  if (!pickerExisting.some((m) => m.name === name)) pickerExisting.push({ name, caps: [] });
  if (!pickerTemp.some((m) => m.name === name)) pickerTemp.push({ name, caps: [] });
  $("mmManual").value = "";
  if (pickerTab !== "existing") { pickerTab = "existing"; setMmTabs(); }
  renderMmList();
});
$("mmPull").addEventListener("click", async () => {
  const c = channels[editingIndex] || {};
  const base = ($("chEndpoint").value || c.endpoint || "").trim();
  const key = ($("chKey").value || c.key || "").trim();
  const proto = $("chProto").value || c.proto || "typesafe";
  const msg = $("mmPullMsg");
  msg.style.color = "";
  msg.textContent = "拉取中…";
  try {
    const res = await sendMsg({ type: "LIST_MODELS", channel: c.role || "", base, key, proto });
    if (res?.ok) {
      pickerFetched = (res.models || []).map((n) => ({ name: n, caps: [] }));
      msg.textContent = `✓ 获取到 ${pickerFetched.length} 个模型（${res.url || base}）`;
      pickerTab = "fetched"; setMmTabs(); renderMmList();
    } else if (res?.suggest?.length) {
      // SystemOne 兼容端点没有 /models：列出建议模型，勾选即可加入
      pickerFetched = res.suggest.map((n) => ({ name: n, caps: [] }));
      msg.style.color = "#d97706";
      msg.textContent = `⚠ ${res.reason}；已列出建议模型 ${res.suggest.length} 个，勾选后确定即可`;
      pickerTab = "fetched"; setMmTabs(); renderMmList();
    } else {
      msg.textContent = "✗ " + (res?.reason || "拉取失败");
    }
  } catch (e) { msg.textContent = "✗ " + e.message; }
});
document.querySelectorAll(".mm-tab").forEach((t) =>
  t.addEventListener("click", () => { pickerTab = t.dataset.mmtab; setMmTabs(); renderMmList(); }));
$("mmAll").addEventListener("click", () => {
  const list = pickerTab === "fetched" ? pickerFetched : pickerExisting;
  for (const m of list) if (!mmIsSel(m.name)) pickerTemp.push({ name: m.name, caps: (pickerTemp.find((x) => x.name === m.name)?.caps) || [] });
  renderMmList();
});
$("mmNone").addEventListener("click", () => {
  const list = pickerTab === "fetched" ? pickerFetched : pickerExisting;
  const inTab = new Set(list.map((m) => m.name));
  pickerTemp = pickerTemp.filter((x) => !inTab.has(x.name));
  renderMmList();
});
$("mmOk").addEventListener("click", () => {
  if (editingIndex >= 0) channels[editingIndex].models = pickerTemp.map((m) => ({ name: m.name, caps: m.caps || [] }));
  renderModelRows(channels[editingIndex].models);
  $("modelModal").hidden = true;
});
$("mmCancel").addEventListener("click", () => { $("modelModal").hidden = true; });
$("mmClose").addEventListener("click", () => { $("modelModal").hidden = true; });

// ============ 功能配置保存（独立于渠道） ============
$("saveSettingsBtn").addEventListener("click", async () => {
  const cfg = {
    vision: $("visionOn").checked,
    routeOn: $("routeOn").checked,
    probeOn: $("probeOn").checked,
    routeTopBar: parseFloat($("routeTopBar").value) || 0.6,
    probeLockBar: parseFloat($("probeLockBar").value) || 0.6,
    sweepStrategy: $("sweepStrategy").value || "onDemand",
    sweepMaxSteps: parseInt($("sweepMaxSteps").value, 10) || 6,
    sweepStepRatio: parseFloat($("sweepStepRatio").value) || 0.8,
  };
  await sendMsg({ type: "USER_INFO", user: { name: $("userName").value, tenant: $("userTenant").value } });
  const res = await sendMsg({ type: "SET_CONFIG", config: cfg });
  if (res?.ok) {
    try { chrome.storage.local.get("config", (d) => { chrome.storage.local.set({ config: Object.assign({}, d.config || {}, cfg) }); }); } catch (_) {}
    alert("功能配置已保存。");
  } else alert("保存失败");
});

// ---- 冷启动即时渲染：不依赖 service worker 唤醒，先本地填充，再重试 GET_STATE ----
function applyConfig(c) {
  if (!c) return;
  // 渲染模型渠道列表（替代旧版逐项填充的表单）
  channels = buildChannels(c);
  renderChannels();
  // 功能配置
  $("visionOn").checked = !!c.vision;
  $("routeOn").checked = c.routeOn !== false;
  $("probeOn").checked = c.probeOn !== false;
  $("routeTopBar").value = c.routeTopBar ?? 0.6;
  $("probeLockBar").value = c.probeLockBar ?? 0.6;
  $("sweepStrategy").value = c.sweepStrategy || "onDemand";
  $("sweepMaxSteps").value = c.sweepMaxSteps ?? 6;
  $("sweepStepRatio").value = c.sweepStepRatio ?? 0.8;
}

function showInstantPlaceholders() {
  // 立即显示欢迎语，避免“白屏/文字少”
  const chat = $("chat");
  if (chat && !chat.children.length) {
    const w = document.createElement("div");
    w.className = "msg sys";
    w.style.whiteSpace = "pre-wrap";
    w.textContent = "欢迎使用 JEV Web Control 👋\n在下方描述你的网页自动化目标，或先到「设置」配置 JEV 模型。";
    chat.appendChild(w);
  }
  // 本地存储先填设置页（渠道列表 + 功能配置）
  try {
    chrome.storage.local.get("config", (d) => {
      if (d && d.config) applyConfig(d.config);
    });
  } catch (_) {}
}

function initGetState(attempt) {
  attempt = attempt || 1;
  sendMsg({ type: "GET_STATE" })
    .then((res) => {
      if (!res?.ok) { if (attempt < 5) return initGetState(attempt + 1); return; }
      renderState(res.state);
      applyConfig(res.state.config || {});
      if (res.state.run?.running) startPolling();
    })
    .catch(() => { if (attempt < 5) setTimeout(() => initGetState(attempt + 1), 400); });
}

// init
showInstantPlaceholders();
initGetState(1);
