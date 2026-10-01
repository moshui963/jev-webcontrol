---
name: "jev-webcontrol"
summary: "为已有网页自动化流程找最佳路径、为改版后的流程自动修复断点，并产出可复用的 flow Skill 包（对话式 HITL）。"
read_when:
  - 用户想为某个网页任务生成/优化自动化流程或技能包
  - 用户说"页面改版了，原来的自动化跑不通了，帮我修"
  - 用户想评估某个网页自动化流程的健壮性与定位器策略
---

# JEV Web Control

把"大模型思考慢 / 元素难找 / 流程脆弱"三个痛点，用 **Jev 式的快速选择决策 + 抗改版 durable locator + 声明式验证 + 对话式人工确认（HITL）** 解决，最终产出可复用的 **flow Skill 包**。

## 站在谁肩膀上
- 感知/执行层复用 `jev-ultrafast`（`snapshot.js` / `browser.py`），并扩展穿透 **open shadow root + 同源 iframe**（`scripts/snapshot_extended.js`）。
- 决策/验证/打包范式参考 `jev-browser-use`：**Jev 决策快而便宜，宿主（人）负责验证**，凭证严格外置。
- 本工具补充两者都没有的三层：**durable locator 合成**、**改版断点自修复**、**可复用 flow Skill 产物**。

## 核心原则（务必遵守）
1. **模型只做选择题**：操作(operation)与目标(target)是索引化元素表里的选择题；只有 TYPE_TEXT 才调一个小模型生成字段值，且强制 `{"text": "..."}`。
2. **模型输出永不当选择器/坐标/JS**：真实 DOM 引用、几何、命中测试全在 `snapshot_extended.js` 代码侧。
3. **Jev 永不自判通过**：`needs_verification` 只是交接信号，成败由声明式规范 + 你的最终确认决定（HITL）。
4. **敏感操作强制人工**：支付/删除/提交/发送等（`policy.py` 的 sensitive_keywords / deny_names / min_confidence）必须停下来交给你确认。

## 工具怎么用（你在对话里这样驱动）
你只需说一句目标，例如：
> "帮我把『苏黎世→伦敦查机票』做成技能包，页面改版了也能自动修"

然后**每步**我都按下面闸门走，并在执行前把"元素表 + 建议操作 + 目标 + locator + 待填文本"抛给你确认：

```
observe  →  decide  →  [HITL 闸门: 你确认/改选/叫停]  →  act  →  verify
   ↑                                                                  │
   └──────────────────────── 未通过则重试/换策略 ───────────────────┘
```

- `observe`：注入 `snapshot_extended.js`，拿到带 scope 的作用域元素表（穿透 shadow/iframe）。
- `decide`：`decide.py` 用 `mock` / `typesafe` / `openrouter` 三选一给出 `{operation, target, confidence}`。
- `HITL 闸门`：`policy.py` 判定 —— 敏感或低置信度 → 强制你确认；`allow_origins` 不符 → 直接禁止。
- `act`：`harness.py` 经 CDP 执行（locator 解析 → 几何校验 → 点击/输入/选择）。
- `verify`：`verify.py` 用声明式规范程序化判定，不轻信 DONE。
- 走完所有步骤 → `package.py` 产出 flow Skill 包。

## 两个场景
**场景 A — 已有/参考流程，找最佳路径并打包**
输入：任务描述 + 参考步骤（可选）。让 agent 跑一遍，挑"能通过验证、且 locator 最稳"的路径 → 产出 flow Skill 包。
> 离线演示：`python scripts/package.py` 会直接产出一个示例包到 `examples/flow-flight-search/`。

**场景 B — 网页改版，旧技能断点自修复**
输入：旧 flow Skill 包 + 重新抓的 DOM 快照。
`repair.py` 拿旧 locator 去新页面 `resolve_offline`：
- 仍命中 → 复用；
- 不命中 → 断点；用**语义身份(role+可读名)**跨作用域回找，找到则就地更新 locator（自动修复）；
- 找不到 → 标记 `needs_human`，交回 HITL。
> 离线演示：`python scripts/repair.py --plan tests/fixtures/plan_v1.json --state tests/fixtures/state_after.json`

## 产物（flow Skill 包结构）
```
<flow>/
  SKILL.md              # 这份流程怎么重放
  scripts/replay.py     # 自包含 runner：--dry-run 离线 / --url 真机
  references/plan.yaml  # 步骤 + durable locator + 验证规范
  report.md             # 构建记录 + 局限
```
重放：`python scripts/replay.py --dry-run --state page.json`（离线）或 `--url <live>`（需 Chrome daemon）。

## 脚本索引（scripts/）
| 文件 | 层 | 职责 |
|---|---|---|
| `snapshot_extended.js` | M1 感知 | 穿透 shadow+iframe 的快照；含 `locatorOf`/`resolve`/`evaluateSpec` |
| `harness.py` | 执行 | CDP 浏览器控制 + 跨源 frame 合并 |
| `locator.py` | M2 定位 | locator 排序/生成注入脚本 + `resolve_offline` |
| `decide.py` | M3 决策 | 双 provider（typesafe/openrouter/mock）决策 + 文本生成 |
| `verify.py` | M4 验证 | 声明式规范解析/离线判定/实时脚本 |
| `policy.py` | M7 安全 | 敏感操作/低置信/源站门禁 |
| `repair.py` | M5 修复 | 旧 skill + 新快照 diff → 自动修复/标断点 |
| `package.py` | M6 产物 | 打包 flow Skill 包 |

## 已知边界（务必如实告知用户）
- 不支持：canvas 控件、封闭 shadow root、复杂键盘控件、系统文件上传弹窗、跨源 iframe 内的实时交互（仅合并快照）。
- 真机端到端需要 Chrome daemon（`harness.py` 依赖 `browser-harness`）；当前所有验证均可在**无浏览器**下用捕获快照跑通。
- 决策层的 `mock` provider 仅用于本地结构验证；真实速度与精度需 `typesafe`/`openrouter` key。
