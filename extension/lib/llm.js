// lib/llm.js — DeepSeek (OpenAI-compatible) client.
// Used for: (1) NL -> structured plan JSON, (2) snapshot+intent -> top-K decision
// (fallback when no TypeSafe key), (3) field values for fill actions.
import { normalizeDate } from "./actions/registry.js";

export const DEFAULT_LLM = {
  deepseekBase: "https://api.deepseek.com/v1",
  deepseekModel: "deepseek-chat",
};

async function chat(cfg, messages, { json = false, maxTokens = 2048 } = {}) {
  let base = (cfg.deepseekBase || DEFAULT_LLM.deepseekBase).replace(/\/+$/, "");
  // Users often paste a full endpoint URL into the Base field. Normalize the
  // common shapes so the request lands on <base>/chat/completions:
  //  - ".../chat/completions" pasted whole  -> strip the tail
  //  - SystemOne endpoint pasted by mistake -> strip "/systemone"
  base = base.replace(/\/chat\/completions$/i, "").replace(/\/systemone\/?$/i, "");
  const url = base + "/chat/completions";
  // Hard timeout: a stalled request must never park the whole run in
  // "executing" forever (MV3 worker would wait, panel would spin).
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.deepseekKey}` },
    body: JSON.stringify({
      model: cfg.deepseekModel || DEFAULT_LLM.deepseekModel,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("LLM 返回 HTTP " + res.status + "（" + url + "）");
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// Salvage a TRUNCATED JSON object (finish_reason=length): terminate the
// dangling string, strip trailing comma/colon fragments (and dangling keys,
// one per retry), then close unbalanced brackets. A truncated
// {"done":false,"reason":"… still yields a usable verdict instead of
// "应答无法解析" (seen 3× in one run on 2026-09-30: decision / browser-use /
// completion judge).
function closeJson(t0) {
  let t = String(t0 || "").replace(/\\$/, "");
  for (let attempt = 0; attempt < 4; attempt++) {
    // Ended inside a string? Terminate it.
    let inStr = false, esc = false;
    for (const ch of t) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; }
    }
    if (inStr) t += '"';
    // Close unbalanced brackets (string-aware scan).
    const stack = [];
    inStr = false; esc = false;
    for (const ch of t) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") stack.pop();
    }
    if (!inStr && stack.length >= 0) {
      let closed = t;
      while (stack.length) closed += stack.pop() === "{" ? "}" : "]";
      try { return JSON.parse(closed); } catch { /* fall through to strip */ }
    }
    // Strip one trailing fragment and retry: hanging ": , whitespace" first,
    // then a dangling "key" token (anchored on the comma before it so the
    // closing quote of an INTACT key is never eaten).
    const before = t;
    t = t.replace(/[:,\s]+$/, "").replace(/,\s*"(?:[^"\\]|\\.)*"?\s*:?[\s,]*$/, "");
    if (t === before || t.length < 2) return null;
  }
  return null;
}

function parseJsonLoose(text) {
  const s = String(text || "");
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through to salvage */ }
    }
    const start = s.indexOf("{");
    if (start >= 0) {
      const r = closeJson(s.slice(start));
      if (r) return r;
    }
    return null;
  }
}

// (1) Natural language -> structured plan. Returns {steps:[{intent,verb,target,url,value}], entryUrl} or null.
const PLAN_SYSTEM_PROMPT = `你是网页自动化「计划拆分器」。把用户给的中文操作步骤，拆成严格有序、可被程序逐步执行的步骤列表。

# 输出格式（只输出 JSON，不要任何解释、不要 markdown 代码块）
{
  "entryUrl": "入口网址，若用户提到具体网站则填，否则空字符串",
  "steps": [
    {
      "intent": "这一步的中文原话（保留以便对照）",
      "verb": "navigate | fill | search | click | select | setDate",
      "target": "该步骤作用的对象（按钮文字/链接文字/搜索词/输入内容），要精炼准确",
      "url": "仅 navigate 步骤且有明确网址时填，否则空字符串",
      "value": "仅 fill/search 步骤需要填入的文字，其余步骤省略此字段"
    }
  ]
}

# verb 取值规则
- navigate：打开/访问/进入某网站。务必填 url（用户没给网址时按站名推断：百度→https://www.baidu.com，知乎→https://www.zhihu.com，微博→https://weibo.com，淘宝→https://www.taobao.com，京东→https://www.jd.com，B站→https://www.bilibili.com）。
- fill：在输入框里输入文字但不提交。把要输入的【干净文字】同时放进 target 和 value（例如搜索词是 投影灯，就写 投影灯，绝不要写「搜搜投影灯」这种原话）。
- search：单个步骤就完成「输入关键词并提交搜索」的复合动作（仅当用户把搜索当作一步、且后面没有单独的点击查询步骤时说）。需要填 value=关键词。
- click：点击某个按钮或链接。target 要写清楚点的是什么，例如「百度一下（搜索提交按钮）」「搜索结果第一条链接」。
- select：在下拉框里选择某项。
- setDate：在日期/时间选择器里设定一个日期（如「设置开始日期为2026-09-01」）。value 必须写成 YYYY-MM-DD（例如 2026-09-01），target 写日期字段的名字（如「开始日期」）。

# 关键归一化（务必遵守，否则步骤不可执行）
- 「搜搜X / 搜X / 搜索X / 查询X」里的 X 才是要填的值；target 和 value 都写 X。
- 当用户把「搜X」和「点击查询/点击搜索」拆成两步时，必须拆成：第一步 verb=fill、value=关键词；第二步 verb=click、target=该网站的搜索提交按钮（百度就是「百度一下」）。不要合并成 search，也不要把第一步设成 search（search 会自己提交，会和第二步冲突）。
- 「查询/搜索按钮」在百度上实际叫「百度一下」；target 写「百度一下」或「搜索提交按钮」。
- 「帖子/结果/条目」指搜索结果里的链接；点击第 N 条结果时 target 写「搜索结果第 N 条链接」，并强调「第 N 条 / 第一个」。

# 示例
用户输入：
打开百度
搜搜投影灯
点击查询
点击搜索后的第一条帖子

正确输出：
{
  "entryUrl": "https://www.baidu.com",
  "steps": [
    {"intent":"打开百度","verb":"navigate","target":"百度","url":"https://www.baidu.com"},
    {"intent":"搜搜投影灯","verb":"fill","target":"投影灯","value":"投影灯"},
    {"intent":"点击查询","verb":"click","target":"百度一下（搜索提交按钮）"},
    {"intent":"点击搜索后的第一条帖子","verb":"click","target":"搜索结果中第一条链接（第一个结果）"}
  ]
}`;

export async function planFromNL(text, cfg) {
  const content = await chat(
    cfg,
    [
      { role: "system", content: PLAN_SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    { json: true }
  );
  const plan = parseJsonLoose(content);
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return null;
  const steps = plan.steps
    .filter((s) => s && typeof s.intent === "string" && s.intent.trim())
    .map((s) => {
      const verb = ["navigate", "search", "click", "fill", "select", "setDate"].includes(s.verb) ? s.verb : guessVerb(s.intent);
      let value = s.value != null ? String(s.value) : undefined;
      // 日期步骤：若 LLM 没给 value，从意图/目标文字里抽取 YYYY-MM-DD
      if (verb === "setDate" && !value) {
        const d = normalizeDate(s.intent) || normalizeDate(s.target || "");
        if (d) value = `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
      }
      return {
        intent: s.intent.trim(),
        verb,
        target: String(s.target || "").trim(),
        url: String(s.url || "").trim(),
        value,
      };
    });
  if (!steps.length) return null;
  // Safety net: a "search" step immediately followed by an explicit
  // search-button click would double-submit. Downgrade it to a plain fill so
  // the click step performs the submit.
  const SEARCH_BTN = /(百度一下|搜索按钮|查询按钮|提交搜索|search button)/i;
  steps.forEach((s, i) => {
    if (s.verb === "search") {
      const next = steps[i + 1];
      if (next && next.verb === "click" && SEARCH_BTN.test(next.target || "")) s.verb = "fill";
    }
  });
  return { steps, entryUrl: String(plan.entryUrl || "").trim() || steps.find((s) => s.url)?.url || "" };
}

function guessVerb(text) {
  if (/^(打开|访问|进入)/.test(text)) return "navigate";
  // "搜索X/查询X" = fill keyword + submit, not a plain fill.
  if (/^(搜索|搜搜|搜|查询|查找|搜一下)/.test(text)) return "search";
  // 含日期且带日期写法 → 日期选择器动词
  if (/(日期|时间|date)/i.test(text) && /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})|(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.test(text)) return "setDate";
  if (/(输入|填|填写)/.test(text)) return "fill";
  if (/(选|select)/.test(text)) return "select";
  return "click";
}

// (1b) NL goal sentence -> structured objective for the agentic (goal-driven)
// mode. Unlike planFromNL, this does NOT commit to a fixed click sequence. It
// returns the target nouns to anchor on (subGoals) and how to know the GOAL is
// done (successCriteria) — the unknown middle navigation is discovered at run
// time by the Controller. Falls back to lib/goal.js' deterministic extractor
// when this returns nothing usable.
export async function goalFromNL(text, cfg) {
  const content = await chat(
    cfg,
    [
      {
        role: "system",
        content:
          "你是网页自动化目标解析器。用户用一句自然语言描述想达成的终态（不写过程）。" +
          "请拆出：\n" +
          "1) goal: 用户原意的精炼目标；\n" +
          "2) subGoals: 为达成目标需要依次完成的最少动作单元数组，按发生顺序。每个单元是 {\"noun\":\"页面上真实可见的目标名词\",\"verb\":\"动作动词\",\"value\":\"需要填入的文字\"}。" +
          "verb 只能取：click(点击)、fill(向输入框填字)、search(在搜索框填关键词并提交)、select、setDate、read(进入后只需页面出现某内容，如查看/抓取/评论)。\n" +
          "拆解规则：\n" +
          "· 「搜X/搜索X/查X」必须拆成两步：{\"noun\":\"搜索框\",\"verb\":\"fill\",\"value\":\"X\"} → {\"noun\":\"搜索\",\"verb\":\"click\"}（noun 填搜索提交按钮的真实可见文字，如 搜索/百度一下/查 询）。绝不要把「搜X」整体当成一个可点击元素。\n" +
          "· 「第一个产品/第一条结果」是搜索结果里的链接，verb=click，noun=第一个产品。\n" +
          "· 「查看/抓取/爬取/采集/评论」是读目标：verb=read，noun=要出现的内容入口（如 评论）。\n" +
          "· 不要把动词短语（如 抓取它、进入商品详情）当成独立子目标；noun 必须是页面上真实存在或将出现的文字。\n" +
          "3) successCriteria: 如何判断【目标已达成】，signal 取值之一：download(触发下载)、dialogClosed(弹窗关闭)、elementClicked(目标元素被点击/定位)、textPresent(页面出现某文本——抓取/查看/评论类目标必须用它)，并给 value(相关名词或文本)。\n" +
          '只输出 JSON：{"goal":"...","subGoals":[{"noun":"...","verb":"click","value":""}],"successCriteria":{"signal":"...","value":"...","note":"..."}}。',
      },
      { role: "user", content: text },
    ],
    { json: true, maxTokens: 800 }
  );
  const g = parseJsonLoose(content);
  if (!g || !Array.isArray(g.subGoals) || !g.subGoals.length) return null;
  return g;
}

// (2) Snapshot + intent -> top-K decision. Returns {routes:[{action,score}], provider:"deepseek", latencyMs}.
export async function llmDecide(state, goal, k, cfg) {
  const actions = (state.actions || []).filter((a) => ["click", "fill", "select"].includes(a.kind));
  // keep payload small: label + role + id only
  const list = actions.map((a, i) => `${i + 1}. [${a.kind}] [${a.role}] ${a.label}${a.disabled ? "（已禁用）" : ""}`);
  const started = Date.now();
  const content = await chat(
    cfg,
    [
      {
        role: "system",
        content:
          "你是网页自动化决策器。给定页面元素列表和当前步骤目标，选出最能推进目标的元素。" +
          `输出 JSON：{"ranking":[{"n":元素序号,"p":0到1的概率}],"confidence":0到1}，最多给出 ${k} 个，按概率降序。只输出 JSON。`,
      },
      {
        role: "user",
        content: `页面: ${state.url} | ${state.title}\n当前步骤: ${goal}\n元素列表:\n${list.slice(0, 200).join("\n")}`,
      },
    ],
    { json: true, maxTokens: 512 }
  );
  const parsed = parseJsonLoose(content);
  if (!parsed || !Array.isArray(parsed.ranking))
    throw new Error("LLM 决策应答无法解析: " + String(content).slice(0, 120));
  const routes = [];
  for (const r of parsed.ranking.slice(0, k)) {
    const a = actions[Number(r.n) - 1];
    if (a) routes.push({ action: a, score: Math.max(0, Math.min(1, Number(r.p) || 0)) });
  }
  if (!routes.length) throw new Error("LLM 未给出有效候选");
  return { routes, provider: "deepseek", latencyMs: Date.now() - started, confidence: parsed.confidence ?? 0.5 };
}

// (4) browser-use style single-step actor: given the current element tree and
// the step goal, ask DeepSeek for the NEXT one action to take. Returns
// { done:true } when the goal is already satisfied, otherwise
// { done:false, action:{kind,label,locator} }. Used by lib/browseruse.js as the
// in-extension fallback when jev/LLM ranking cannot pick a candidate.
export async function planOneAction(state, goal, lastAction, cfg, probeHint) {
  const actions = (state.actions || []).filter((a) =>
    ["click", "fill", "select", "drag"].includes(a.kind)
  );
  const list = actions.map((a, i) => `${i + 1}. [${a.kind}] [${a.role}] ${a.label}${a.disabled ? "（已禁用）" : ""}`);
  const content = await chat(
    cfg,
    [
      {
        role: "system",
        content:
          "你是浏览器自动化 agent（类似 browser-use）。给定当前页面的元素列表和待完成的目标，" +
          "决定【下一步】应执行的【一个】动作来推进目标。不要一次做多个动作。\n" +
          "动作类型说明：click=点击元素；fill=在输入框填入文字（需给出 value）；select=在下拉框选择；drag=拖拽（用 from/to 的序号）。\n" +
          "若目标已经达成，返回 {\"done\":true}。\n" +
          '输出 JSON：{"done":false,"n":元素序号,"value":"填入文字(仅 fill 需要)","explanation":"简短中文说明"}。只输出 JSON，不要任何解释或代码块。',
      },
      {
        role: "user",
        content:
          `页面: ${state.url} | ${state.title}\n` +
          `目标: ${goal}\n` +
          `上一步动作: ${JSON.stringify(lastAction || null)}\n` +
          (probeHint ? `导航提示（务必遵循）: ${probeHint}\n` : "") +
          `元素列表:\n${list.slice(0, 200).join("\n")}`,
      },
    ],
    // 400 tokens truncated the JSON mid-string when the model wrote a longer
    // explanation — the un-parseable response then killed the whole fallback.
    { json: true, maxTokens: 800 }
  );
  const parsed = parseJsonLoose(content);
  if (!parsed) throw new Error("browser-use 决策应答无法解析: " + String(content).slice(0, 120));
  if (parsed.done) return { done: true };
  const a = actions[Number(parsed.n) - 1];
  if (!a) throw new Error("browser-use 选中的元素序号不存在");
  const action = { kind: a.kind, label: a.label, locator: a.locator };
  if (a.kind === "fill") action.value = String(parsed.value || "").slice(0, 2000);
  return { done: false, action };
}

// (3) Field value for fill actions (spirit of model.py field_text).
export async function fieldValue(goal, action, pageText, cfg) {
  const content = await chat(
    cfg,
    [
      {
        role: "system",
        content:
          "给出应该填入该输入框的确切文字。文字必须来自用户目标中明确要输入的内容" +
          "（例如搜索词、用户名），严禁从页面内容里抄任何文字（页面可能预填了广告或热词）。" +
          '输出 JSON：{"text":"..."}。只输出 JSON。',
      },
      {
        role: "user",
        content: JSON.stringify({
          goal,
          field: { label: action.label, role: action.role, value: action.value || "" },
          page: { text: String(pageText || "").slice(0, 4000) },
        }),
      },
    ],
    { json: true, maxTokens: 256 }
  );
  const parsed = parseJsonLoose(content);
  const value = parsed && typeof parsed.text === "string" ? parsed.text.trim() : "";
  if (!value) throw new Error("LLM 未给出字段值");
  return value.slice(0, 2000);
}

// (4) Vision grounding (Phase 5-B fallback for the DOM probe). Sends a page
// screenshot + the sub-goal noun to an OpenAI-compatible vision model and asks
// for either a click coordinate (fractional 0..1, scaled to viewport in the
// caller) or the name of the group that must be expanded first.
// Returns { mode:"click", fx, fy } | { mode:"expand", group } | null.
// Requires cfg.visionKey (falls back to deepseekKey) — disabled when absent.
export async function groundVision(cfg, screenshotDataUrl, noun) {
  const key = cfg.visionKey || cfg.deepseekKey;
  if (!key || !screenshotDataUrl) return null; // vision not configured -> caller degrades to DOM-only
  let base = (cfg.visionBase || cfg.deepseekBase || DEFAULT_LLM.deepseekBase).replace(/\/+$/, "");
  base = base.replace(/\/chat\/completions$/i, "").replace(/\/systemone\/?$/i, "");
  const url = base + "/chat/completions";
  const model = cfg.visionModel || "gpt-4o";
  const prompt =
    `这是一张网页截图。请定位文字含义为「${noun}」的元素（可能是菜单项、按钮、链接）。\n` +
    `若能在截图里直接看到该元素，返回它的中心坐标，用整张图宽高的【小数比例 0~1】表示：{"mode":"click","fx":0.5,"fy":0.4}。\n` +
    `若它显然藏在某个分组/子菜单里、需要先展开某分组，返回 {"mode":"expand","group":"分组名"}。\n` +
    `若无法确定，返回 {"mode":"none"}。\n只输出 JSON，不要代码块或解释。`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: screenshotDataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("Vision 返回 HTTP " + res.status);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonLoose(text);
  if (!parsed || parsed.mode === "none") return null;
  if (parsed.mode === "click") {
    const fx = Number(parsed.fx), fy = Number(parsed.fy);
    if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return null;
    return { mode: "click", fx, fy };
  }
  if (parsed.mode === "expand" && parsed.group) return { mode: "expand", group: String(parsed.group).slice(0, 40) };
  return null;
}

// (5) Route layer — Plan-and-Execute 的「路线裁判」(LLM 判路线, jev 执行).
// 把旧的「jev -> LLM 兜底 -> browser-use」线性链，改成按角色路由：LLM 在子目标
// 边界判路线并产出后续具体步骤，jev 只负责快速点击。

// 纯函数：解析 Route 层 LLM 应答，单独抽出以便单测（无需联网）。
// 返回 {mode:"route", steps:[...]} | {mode:"direct", target} | {mode:"blocked", reason} | null。
export function parseRouteResponse(text) {
  const p = parseJsonLoose(text);
  if (!p || !p.mode) return null;
  if (p.mode === "route" && Array.isArray(p.steps)) {
    const steps = p.steps
      .filter((s) => s && typeof s.target === "string" && s.target.trim())
      .map((s) => ({
        intent: String(s.intent || s.target).trim(),
        verb: ["click", "fill", "select"].includes(s.verb) ? s.verb : "click",
        target: String(s.target).trim(),
        subGoal: s.subGoal ? String(s.subGoal) : "",
        kind: "refined",
        expandable: false,
      }));
    if (!steps.length) return null;
    return { mode: "route", steps };
  }
  if (p.mode === "direct" && p.target) return { mode: "direct", target: String(p.target).slice(0, 200) };
  if (p.mode === "blocked") return { mode: "blocked", reason: String(p.reason || "路线裁判无法判定").slice(0, 300) };
  return null;
}

// 纯谓词：这一步是否该让 LLM 路线层介入。
// 触发条件（任一即可）：
//  - 动作型多级子目标(step.expandable，如导出/下载)：进入即规划一次（LLM 有真实价值）；
//  - 导航型措辞(找到/进入/...) 且 jev 低置信(top<bar)：jev 拿不准才问 LLM；
//  - DOM 探针无果 且 jev 低置信：探针帮不上忙才升级。
// jev 高置信（>=bar）的导航步骤完全不调 LLM——省掉 3~5s 网络往返（v0.4.14 性能修正：
// 旧版对方向型子目标边界无条件触发，导致每次都白等一次 mode=direct 的 LLM 往返）。
// v0.4.27: fill/search 是「目标元素清晰的具体执行步骤」——输入框候选已在眼前，
// Route 层没有增量价值，直接短路（旧版 directionNoun 里的「搜索」会误命中
// intent「在「搜索框」填写…」，让每次填词都白等一次 30s 的 Route 往返）。
// 无 LLM key 则不触发。
export function needsRoute({ step, top, llmAvailable, probeMode, lowConfBar }) {
  if (!llmAvailable || !step) return false;
  const bar = typeof lowConfBar === "number" && lowConfBar > 0 && lowConfBar < 1 ? lowConfBar : 0.6;
  const lowConf = typeof top === "number" ? top < bar : true;
  if (step.expandable) return true;
  if (step.verb === "fill" || step.verb === "search") return false;
  const directionNoun = /(找到|进入|定位|打开|切换到|展开|查看|前往|导航)/.test(step.intent || "");
  if (directionNoun && lowConf) return true;
  if (probeMode === "none" && lowConf) return true;
  return false;
}

// 调 LLM 判路线：给定当前页面 + 整体目标 + 当前子目标 + 剩余子目标，产出下一步。
// 失败/解析不出 -> 返回 null（调用方降级到 jev / browser-use 兜底）。
export async function routeJudge({ snap, goalContext, noun, remainingSubGoals, lastAction, cfg }) {
  const actions = (snap?.actions || []).filter((a) => ["click", "fill", "select", "drag"].includes(a.kind));
  const list = actions.map((a, i) => `${i + 1}. [${a.kind}] [${a.role}] ${a.label}${a.disabled ? "（已禁用）" : ""}`);
  const SYSTEM = `你是网页自动化「路线裁判」。给定一个方向型子目标和当前页面，决定如何推进。
若目标元素已直接可见，返回 {"mode":"direct","target":"元素文字"}（引用页面上真实存在的元素文字）。
若需要多步才能到达（如先展开分组、再层层点击），返回 {"mode":"route","steps":[{"intent":"...","verb":"click|fill|select","target":"元素文字","subGoal":"..."}]}，每个 target 必须引用页面上真实可见的元素文字。
若目标明显不可达或需要人工判断，返回 {"mode":"blocked","reason":"..."}。
只输出 JSON，不要代码块或解释。`;
  const content = await chat(
    cfg,
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          `整体目标: ${goalContext}\n` +
          `当前子目标: ${noun}\n` +
          `剩余子目标: ${(remainingSubGoals || []).join(" → ")}\n` +
          `上一步: ${JSON.stringify(lastAction || null)}\n` +
          `页面: ${snap?.url || ""} | ${snap?.title || ""}\n` +
          `元素列表:\n${list.slice(0, 200).join("\n")}`,
      },
    ],
    { json: true, maxTokens: 800 }
  );
  return parseRouteResponse(content);
}

// Route layer sub-call: "should this reveal click be skipped?"
// The next-step target is already visible on the page, but that does NOT prove
// this step's reveal already happened (e.g. a multi-level dialog's same-named
// button may be visible for another reason). We hand the STATE ASSESSMENT to the
// LLM: it sees the real page + goal context and decides skip (reveal done) vs
// proceed (click still required). Returns {skip:true,reason} | {skip:false} |
// null (null = no decisive answer; caller treats as "do not skip").
export function parseSkipResponse(text) {
  const p = parseJsonLoose(text);
  if (!p || !p.decision) return null;
  if (p.decision === "skip") return { skip: true, reason: String(p.reason || "Route 判定揭示已发生，可跳过").slice(0, 300) };
  if (p.decision === "proceed" || p.decision === "click") return { skip: false };
  return { skip: false };
}

export async function routeShouldSkip({ snap, target, goalContext, noun, cfg }) {
  const actions = (snap?.actions || []).filter((a) => ["click", "fill", "select", "drag"].includes(a.kind));
  const list = actions.map((a, i) => `${i + 1}. [${a.kind}] [${a.role}] ${a.label}${a.disabled ? "（已禁用）" : ""}`);
  const SYSTEM = `你是网页自动化「路线裁判」的跳过判定子模块。判断当前这步"揭示点击"能否跳过。
背景：下一步目标元素「${target}」已经在页面上可见，但它很可能要由"本步的揭示点击"来打开（例如展开分组、弹出菜单/对话框）。只有当你可以确定本步的揭示效果确实已经发生（例如该元素所在的弹窗/菜单已经处于打开状态、无需再点本步），才返回 skip；否则必须返回 proceed（本步仍需点击）。
只输出 JSON：{"decision":"skip"|"proceed","reason":"简短理由"}。`;
  const content = await chat(cfg, [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `整体目标: ${goalContext}\n` +
        `当前子目标: ${noun}\n` +
        `下一步目标: ${target}\n` +
        `页面: ${snap?.url || ""} | ${snap?.title || ""}\n` +
        `元素列表:\n${list.slice(0, 200).join("\n")}`,
    },
  ], { json: true, maxTokens: 300 });
  return parseSkipResponse(content);
}

// 纯函数：runLoop 步骤耗尽时的决策（Step 0 终止条件核心）。
// 返回: "success"(成功信号已触发) | "continue"(LLM 已补全步骤) |
//        "escalate"(无法补全, 升级人工) | "normal"(顺序模式: 步骤完即完) | "route_try"(尝试 LLM 补全)。
export function planExhaustedAction({ goalMode, successFired, routeExtended, routeExtends, maxExtends = 5 }) {
  if (!goalMode) return "normal";
  if (successFired) return "success";
  if (routeExtended) return "continue";
  if (routeExtends >= maxExtends) return "escalate";
  return "route_try";
}

// (6) Semantic completion judge — the authoritative "is the user's GOAL really
// done?" gate that replaces a single hardcoded signal (download / elementClicked).
// After every step runs (and especially when steps are exhausted), DeepSeek looks
// at the FINAL page + the run log + the deterministic signals and decides whether
// the user's *semantic* objective is achieved. This is what makes
// "导出所有合同记录" work: clicking 导出 alone is NOT enough — the range dialog
// may still be open, "全部" may not be selected, or the file may not have
// downloaded. The LLM returns `missing` steps so the engine can extend & retry.
//
// `judgeVerdict` is the pure parser (unit-tested); `goalComplete` wraps the call.
export function judgeVerdict(raw) {
  const p = parseJsonLoose(raw);
  if (!p) return { done: false, reason: "完成裁判应答无法解析", missing: [] };
  return {
    done: !!p.done,
    reason: typeof p.reason === "string" ? p.reason : "",
    missing: Array.isArray(p.missing)
      ? p.missing.map((m) => ({
          intent: m.intent || "点击 " + (m.target || ""),
          verb: m.verb || "click",
          target: m.target || "",
        }))
      : [],
  };
}

export async function goalComplete({ goal, subGoals, successCriteria, snap, runLog, downloadFired, history, cfg }) {
  const logText = (runLog || []).map((l) => `${l.tag}: ${l.text}`).join("\n");
  const actions = (snap && snap.actions ? snap.actions : [])
    .slice(0, 60)
    .map((a, i) => `${i + 1}. [${a.kind || "?"}] ${a.label || ""}${a.disabled ? "（已禁用）" : ""}`)
    .join("\n");
  const content = await chat(
    cfg,
    [
      {
        role: "system",
        content:
          "你是网页自动化任务的「完成裁判」。给定用户原始目标、已执行步骤日志、以及当前最终页面状态，判断用户的【语义目标】是否真正达成。\n" +
          "关键：步骤都点过 ≠ 目标达成。例如「导出所有合同记录」要求：导出对话框已正确选择「全部/所有」范围并已确认，且文件已开始下载（或下载已完成）；若只是点了「导出」按钮但对话框还开着、或没选范围、或没真正下载，则视为未完成。\n" +
          "证据：downloadFired=" +
          (downloadFired ? "true（浏览器确认已触发下载）" : "false（未观测到下载）") +
          "。\n" +
          '只输出 JSON：{"done":true/false,"reason":"简短中文说明","missing":[{"intent":"下一步意图","verb":"click","target":"目标文字"}]}。若 done=true，missing 为空数组。',
      },
      {
        role: "user",
        content:
          `用户目标: ${goal || ""}\n` +
          `子目标: ${(subGoals || []).map((s) => s.noun).join(" → ")}\n` +
          `完成判定提示: ${successCriteria?.signal || "-"}${successCriteria?.note ? `（${successCriteria.note}）` : ""}\n` +
          `执行日志:\n${logText || "（空）"}\n` +
          `当前页面: ${snap?.url || ""} | ${snap?.title || ""}\n` +
          `页面可见元素(节选):\n${actions || "（空）"}`,
      },
    ],
    { json: true, maxTokens: 800 }
  );
  return judgeVerdict(content);
}
