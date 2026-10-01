// lib/jev.js — real TypeSafe (jev) SystemOne client.
//
// Targets the Aliyun MAAS "compatible-mode" SystemOne endpoint (and the native
// api.typesafe.ai/v1/systemone noul format):
//
//   POST {endpoint}
//   body: {
//     model: "<model>",
//     state: "<page digest string>",
//     questions: { "<id>": { type: "noul", instructions: "<yes/no probe>" }, ... }
//   }
//   -> {
//        model, request_id,
//        answers: { "<id>": { type: "noul", noul: <0..1 probability> }, ... },
//        usage, latency_ms
//      }
//
// Strategy: each candidate element becomes ONE noul question — "Is this the
// correct next action to progress <goal>? yes/no." The `noul` value is the
// probability the answer is yes; higher = better candidate. We rank candidates
// by noul and return the Top-K as routes. A `done` sentinel probes whether the
// whole goal is already satisfied on the page.

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const KIND_ZH = { click: "点击", fill: "输入文字", select: "选择选项" };
const MAX_CANDIDATES = 100;
// Compatible-mode SystemOne endpoint hard limit (observed via HTTP 400:
// "questions: 101 exceeds the limit of 16").
const MAX_QUESTIONS_PER_REQUEST = 16;

async function postJson(url, key, body) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error("jev 模型连接失败: " + e.message);
    }
    if ([429, 503, 529].includes(res.status) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error("jev 模型返回 HTTP " + res.status);
    return res.json();
  }
  throw new Error("jev 模型不可用");
}

// Build the SystemOne noul request body. Returns { body, candidates }.
export function buildRequest(state, goal, history, model, maxCandidates = MAX_CANDIDATES) {
  const text = String(state?.text || "").slice(0, 3000);
  const pageDigest =
    `URL: ${state?.url || ""}\n` +
    `标题: ${state?.title || ""}\n` +
    `自动化目标: ${goal}\n` +
    `页面可见文本（摘要）:\n${text}`;

  const candidates = (state?.actions || [])
    .filter((a) => ["click", "fill", "select"].includes(a.kind))
    .slice(0, maxCandidates);

  const questions = {};
  candidates.forEach((a, i) => {
    const idx = i + 1;
    const label = String(a.label || a.role || "(无标签)");
    const verb = KIND_ZH[a.kind] || a.kind;
    questions["c" + idx] = {
      type: "noul",
      instructions:
        `自动化目标: ${goal}。\n` +
        `候选元素[${idx}]是「${label}」，下一步应对它执行【${verb}】。` +
        `判断这个元素是否是推进目标的正确操作，只回答 yes 或 no。`,
    };
  });

  // DONE sentinel: is the whole goal already satisfied on this page?
  questions.done = {
    type: "noul",
    instructions: `自动化目标: ${goal}。\n判断当前页面是否已经完整满足了该目标（任务已可结束），只回答 yes 或 no。`,
  };

  const body = {
    model: model || "decision-model-preview",
    state: pageDigest,
    questions,
  };
  return { body, candidates };
}

// Full choose + top-K extraction via noul questions. Candidates are batched
// (max 15 + done-probe per request) and sent in parallel; a failed batch only
// drops its own candidates. Returns { routes:[{action, score}], provider:"jev",
//          latencyMs, operation, confidence, doneScore, model, usage, batches }.
export async function typesafeDecide(state, goal, k, cfg, history = []) {
  const endpoint = cfg.typesafeEndpoint || DEFAULT_ENDPOINT;
  const model = cfg.typesafeModel || "decision-model-preview";
  const text = String(state?.text || "").slice(0, 3000);
  const pageDigest =
    `URL: ${state?.url || ""}\n` +
    `标题: ${state?.title || ""}\n` +
    `自动化目标: ${goal}\n` +
    `页面可见文本（摘要）:\n${text}`;

  const candidates = (state?.actions || [])
    .filter((a) => ["click", "fill", "select"].includes(a.kind))
    .slice(0, MAX_CANDIDATES);
  if (!candidates.length) throw new Error("页面没有可点击/输入/选择的候选元素");

  const CHUNK = MAX_QUESTIONS_PER_REQUEST - 1; // leave room for the done probe
  const chunks = [];
  for (let i = 0; i < candidates.length; i += CHUNK) chunks.push(candidates.slice(i, i + CHUNK));

  const doneProbe = {
    type: "noul",
    instructions: `自动化目标: ${goal}。\n判断当前页面是否已经完整满足了该目标（任务已可结束），只回答 yes 或 no。`,
  };

  const started = Date.now();
  const results = await Promise.allSettled(
    chunks.map((chunk, ci) => {
      const questions = {};
      chunk.forEach((a, i) => {
        const idx = ci * CHUNK + i + 1; // global candidate index (1-based)
        const label = String(a.label || a.role || "(无标签)") + (a.disabled ? "（已禁用）" : "");
        const verb = KIND_ZH[a.kind] || a.kind;
        questions["c" + (i + 1)] = {
          type: "noul",
          instructions:
            `自动化目标: ${goal}。\n` +
            `候选元素[${idx}]是「${label}」，下一步应对它执行【${verb}】。` +
            `判断这个元素是否是推进目标的正确操作，只回答 yes 或 no。`,
        };
      });
      if (ci === 0) questions.done = doneProbe;
      return postJson(endpoint, cfg.typesafeKey, { model, state: pageDigest, questions });
    })
  );

  // Merge per-batch answers; a rejected batch just leaves its scores as NaN.
  const scores = new Array(candidates.length).fill(NaN);
  let doneScore = 0;
  let okBatches = 0;
  let lastErr = null;
  results.forEach((r, ci) => {
    if (r.status !== "fulfilled") {
      lastErr = (r.reason && r.reason.message) || String(r.reason);
      return;
    }
    okBatches++;
    const answers = (r.value && r.value.answers) || {};
    chunks[ci].forEach((a, i) => {
      const ans = answers["c" + (i + 1)];
      const n = ans && typeof ans.noul === "number" ? ans.noul : NaN;
      if (isFinite(n) && n >= 0 && n <= 1) scores[ci * CHUNK + i] = n;
    });
    if (ci === 0 && typeof answers.done?.noul === "number") doneScore = answers.done.noul;
  });

  if (!okBatches) {
    throw new Error(
      `jev 分批请求全部失败（共 ${chunks.length} 批）` + (lastErr ? `: ${lastErr}` : "")
    );
  }

  const scored = [];
  candidates.forEach((a, i) => {
    const n = scores[i];
    if (isFinite(n)) scored.push({ action: a, score: Math.round(n * 1000) / 1000 });
  });
  if (!scored.length) {
    throw new Error("jev 未对任何候选返回有效的 noul 概率" + (lastErr ? `（部分批次失败: ${lastErr}）` : ""));
  }
  scored.sort((x, y) => y.score - x.score);

  return {
    routes: scored.slice(0, k),
    provider: "jev",
    latencyMs: Date.now() - started,
    operation: "ACT",
    confidence: scored[0].score,
    doneScore,
    model,
    usage: {},
    batches: { total: chunks.length, ok: okBatches },
  };
}

// ---- OpenAI-compatible adapter (covers self-hosted / alternative jev models
// that expose a chat/completions endpoint). We send a prompt describing the
// candidates and ask for a JSON choice; no SystemOne schema required. ----
export async function openaiDecide(state, goal, k, cfg, history = []) {
  const endpoint = cfg.typesafeEndpoint;
  if (!endpoint) throw new Error("OpenAI 兼容模式需要填写端点 URL");
  const cands = (state.actions || []).filter((a) => ["click", "fill", "select"].includes(a.kind));
  if (!cands.length) throw new Error("没有候选元素可供决策");
  const list = cands
    .map((a, i) => `[${i + 1}] ${a.kind} · ${a.label || a.role || "(无标签)"}${a.disabled ? "（已禁用）" : ""}`)
    .join("\n");
  const system =
    "你是一个网页自动化决策引擎。根据候选元素和自动化目标，选择最匹配的操作元素。只输出 JSON。";
  const user =
    `目标: ${goal}\n候选元素:\n${list}\n\n` +
    `请输出 JSON: {"choice": <整数, 1..${cands.length}>, "confidence": <0..1>, ` +
    `"alts": [<整数,... 最多 ${k - 1} 个, 不含 choice>]}`;
  const body = {
    model: cfg.typesafeModel || "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  };
  const started = Date.now();
  const res = await postJson(endpoint, cfg.typesafeKey, body);
  const content = res.choices?.[0]?.message?.content;
  if (!content) throw new Error("jev(OpenAI) 返回空内容");
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("jev(OpenAI) 应答不是合法 JSON");
  }
  const used = new Set();
  const out = [];
  const addIdx = (idx) => {
    idx = Number(idx);
    if (!Number.isInteger(idx) || used.has(idx) || !cands[idx - 1]) return;
    used.add(idx);
    out.push({ action: cands[idx - 1], score: parsed.confidence || 0.5 });
  };
  addIdx(parsed.choice);
  for (const alt of Array.isArray(parsed.alts) ? parsed.alts : []) addIdx(alt);
  return {
    routes: out.slice(0, k),
    provider: "jev(openai)",
    latencyMs: Date.now() - started,
    operation: "(openai-choice)",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    doneScore: 0,
    model: res.model,
    usage: res.usage || {},
  };
}
