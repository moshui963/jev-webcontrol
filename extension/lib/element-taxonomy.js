// lib/element-taxonomy.js
// 元素 / 动作分类的「单一事实来源」(Single Source of Truth)。
//
// 设计目标（与 v0.4.22 把 isButtonLike 收进 dom-cues.js 是同一思路，只是放大到全元素）：
//   - 收集器（观察层）用它给每个元素打标：category(大类) + kind(执行 verb) + conf(置信度)
//   - 决策层（LLM / jev）读 category 决定方向，不必再猜「这东西该怎么动」
//   - 执行层按 kind 在 lib/actions/registry.js 里找对应 executor
// 三层共用同一份契约 → 新增一类元素只改这里 + 加一个 executor，不散落改三处。
//
// 暂不做 ML「打标学习」：目前是规则式 detect() + 置信度。注册表本身就是未来接
// 分类模型的 substrate（把 detect 换成模型调用即可，契约不变）。

// 执行层动作动词表（与快照候选的 kind 字段一一对应，是决策/执行统一的标准）。
// 计划层 step.verb（navigate/fill/search/select/click）是 LLM 出的「方向」，
// 这里的是真正干活的动词。两者通过 planFromNL 映射。
export const ACTION_VERBS = [
  "click",    // 激活类：按钮/链接/标签/菜单项
  "fill",     // 文本类：input/textarea/contenteditable
  "select",   // 选择类：native <select> / combobox 选项
  "check",    // 选择类：勾选 checkbox
  "toggle",   // 选择类：开关 switch
  "setDate",  // 调节类：日期/时间选择器（新增）
  "setRange", // 调节类：滑块 range / 步进器
  "upload",   // 文件类：input[type=file]
  "hover",    // 揭示类：悬停展开菜单/tooltip
  "drag",     // 拖拽类：拖拽/排序/缩放手柄
  "scroll",   // 滚动类：无限列表/懒加载
  "read",     // 状态类：仅校验，不动作（progress/spinner）
];

// 网页元素交互「大分类」——按交互意图分，而非 HTML 标签。这样新标签能归到既有类。
// 每个类声明它对应的 verb（取首要 verb 作为默认 kind）。
//
// classifyElement 是自包含函数（detect 逻辑内联其中），可直接 toString() 注入收集器，
// 与 dom-cues.js 的 IS_BUTTON_SRC 注入方式一致，避免两个引擎漂移。
export const CATEGORY_LABELS = {
  activation: "激活类",
  text: "文本类",
  selection: "选择类",
  adjust: "调节类",
  reveal: "揭示类",
  drag: "拖拽类",
  file: "文件类",
  scroll: "滚动类",
  observe: "状态类",
};

// 自包含分类器：检测单个元素返回 {category, kind, conf} 或 null。
// 注意：函数体内不得引用外部作用域变量（保证注入收集器后能独立运行）。
export function classifyElement(el) {
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
}

// 注入收集器用的自包含源码（含上面的全部逻辑，无外部依赖）。
export const CLASSIFY_SRC = classifyElement.toString();

// verb → category 映射（决策/面板用）。与 CATEGORIES 保持一致，但单独列出以便轻量引用。
export const VERB_CATEGORY = ACTION_VERBS.reduce((m, v) => {
  const map = {
    click: "activation", fill: "text", select: "selection", check: "selection",
    toggle: "selection", setDate: "adjust", setRange: "adjust", upload: "file",
    hover: "reveal", drag: "drag", scroll: "scroll", read: "observe",
  };
  m[v] = map[v] || "activation";
  return m;
}, {});
