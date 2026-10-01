# JEV Web Control

> 给国人一个亲身体验 JEV 模型的网页自动化插件：用自然语言描述步骤，插件自动穿透 Shadow DOM / iframe，用束搜索（Beam Search）找出最稳的自动化路线，产出 Agent 可直接消费的结构化方案。

[![GitHub](https://img.shields.io/badge/GitHub-moshui963%2Fjev--webcontrol-blue?logo=github)](https://github.com/moshui963/jev-webcontrol)
[![License](https://img.shields.io/badge/license-MIT-green)](#许可证)

## 为什么做这个项目

近期 JEV 模型（Jev 风格 fast-decision 的浏览器决策小模型）很火，但能直接跑的测试用例几乎都是国外站点，国内用户很难直观上手。本项目把「JEV 风格的高速决策 + 网页自动化」打包成一个**浏览器插件**，让任何人都能用中文描述「打开百度、搜 xxx、点第一条」这类目标，亲眼看到 JEV 是怎么一步步选元素、走路线、产出可复用方案的。

## ✨ 核心特性

- **自然语言驱动**：一句话描述最终目标，插件自动解析成可执行的 Plan。
- **Shadow DOM + iframe 穿透**：采集主文档 / Shadow Root / 跨域 iframe 三作用域元素，真正覆盖 Salesforce、Lit/Ionic 等现代组件与嵌入式页面。
- **Durable Locator（持久定位器）**：按 `semantic > css-id > css-path` 合成，跨刷新 / 换页稳定，重放时自动重解析。
- **束搜索（Beam Search，宽度 K）**：多标签并行探索候选路线，剪枝后保留评分最高的「主路径 + 备用路径」，复杂页面可调 K。
- **HITL 人机协同**：敏感操作 / 低置信 / 多标签歧义一律暂停，等人工确认再执行。
- **Agent 可消费的结构化 MD**：一键产出方案，可下载为 MD / Skill 包 / replay 脚本 / Playwright / JSON，多处复用。
- **本地优先 · 隐私安全**：默认本地模式，数据不出浏览器；Key 仅存 `chrome.storage`，全部留空即走 mock 模式。

## 🚀 快速开始

### 方式一：Chrome 扩展（主形态，推荐）

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录
4. 把扩展固定到工具栏，点开侧边栏即可使用

> 模型 Key 在「设置 → 模型配置」里填：jev 决策引擎 / DeepSeek 路线裁判 / Vision 视觉兜底，全部留空则走本地 mock 模式。

### 方式二：Node 演示面板（离线看穿透效果）

```bash
npm install
npm run web          # 启动 server.mjs，终端会打印本地地址
```

打开终端打印的 `http://localhost:xxxx`，在输入框贴任意网址（支持 Shadow DOM / iframe），点「观察页面」即可看元素树 + 高亮 + 定位器 + HITL 决策演示。

```bash
npm run demo:serve   # 启动 3 作用域穿透演示（主文档 / ::shadow / iframe）
npm test             # 运行 JS 单测
```

## 🧩 两种形态

| 形态 | 目录 | 说明 |
|------|------|------|
| Chrome 扩展（MV3） | `extension/` | 在用户真实浏览器会话内运行，overlay 实时画在页面上，多标签由 `chrome.tabs` 原生管理（主力形态） |
| Node 演示面板 | `server.mjs` + `public/` | 「Node 本地面板 + CDP 驱动」形态，用作离线演示与算法验证 |

## 📐 核心能力详解

- **穿透快照**：递归穿透 open Shadow Root 与同/跨源 iframe，为每个候选打 `scope` 标签，产出三作用域元素树。
- **决策 / 策略 / 修复**：jev 负责每一步「选哪个元素、走哪条候选」（毫秒级、低成本）；LLM 负责计划解析与路线裁判；Vision 兜底视觉判断；断点语义恢复（repair）让「测出来的最佳路线」长期可用。
- **多标签串联**：`workingTabId` 把「页面刷新」和「换标签页」统一成「换了个 DOM 重新解析一遍 locator」，定位器是唯一稳定黏合剂。

## 📁 项目约定

> **所有设计 / 说明类 `.md` 文档统一放在 `doc/` 目录下；仓库根目录仅保留本 `README.md`。**
> 新增文档请直接放入 `doc/`，不要散落在根目录。

## 📚 文档

- `doc/扩展设计文档.md` — 底层引擎设计（快照穿透 / durable locator / decide / policy / repair / HITL / 校验 / 多标签串联）
- `doc/插件产品设计文档.md` — 产品形态设计（用户看到什么、怎么用、怎么卖 / 协作）

## 🤝 贡献

欢迎 Issue / PR。无论是新的穿透场景、决策策略，还是中文站点用例，都能让国人更快用上 JEV 模型。

## ⭐ 点个 Star

如果这个项目帮你直观体验了 JEV 模型，欢迎到 [GitHub](https://github.com/moshui963/jev-webcontrol) 点个 ⭐，你的支持是持续维护的动力！

## 📜 许可证

MIT
