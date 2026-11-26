# 架构与数据流

## 一句话

Electron 主进程负责"编排"，渲染层只是一块控制面板，真正的浏览器操作发生在右侧 `WebContentsView` 里的内嵌页面上。

## 一次完整流程

```
抓简历(在线/上传) → 清洗(cleanResumeText) → 解析(parseResume)
      → 结构化重建 + 压夸(toneDownClaims/truthGate) → 写回/本地保存

需求(大白话) → intent.parse → prefs{城市,薪资,出差天数,自驾,排除项}

搜索页 → scraper 抓岗位卡片 → score 六维分 + intent 偏好加减分
      → matchLlm 批量精排(限时/并发/缓存) → 阈值筛选 → guard 配额
      → automation 逐个投递 → 记录 run/steps

消息页 → scraper 抓会话列表 → 打开会话
      → 有「同意」按钮：直接点，不发文字
      → 否则：读最近对话 → hrMind.analyze(意图/潜台词/策略)
      → personaRules.decide(规则) + llmDraft(模型按人设重写)
      → guard 频率校验 → 发送 → memory.remember 沉淀
```

## 模块职责

| 文件 | 职责 | 备注 |
| --- | --- | --- |
| `main.js` | 窗口/视图布局、IPC、自动流程触发、空闲学习定时 | 所有写操作都从这里发起 |
| `src/engine/scraper.js` | 页面内取数脚本（岗位、会话、消息、同意按钮） | 站点 DOM 相关，易变 |
| `src/engine/automation.js` | 页面内动作（点击、滚动、发送、投递） | 与 scraper 成对维护 |
| `src/engine/resume.js` | 简历清洗、结构化渲染、压夸、门禁 | 只改 bullet，不动事实字段 |
| `src/engine/parse.js` | 简历文本 → 结构 | 按小节切分，容错优先 |
| `src/engine/intent.js` | 自由需求 → 偏好，岗位加减分 | 支持 k/万/元、300 天、自驾 |
| `src/engine/score.js` | 六维加权打分 | 技能/经验/关键词/地点/薪资/公司 |
| `src/engine/matchLlm.js` | 模型精排 | 批量 3 个、并发 2、预算 240s、3 天缓存 |
| `src/engine/hrMind.js` | HR 心理分析 | 12 类意图 + 策略 + 规则兜底 |
| `src/engine/personaRules.js` | 回复规则 | 要简历点同意、三天不重复、不反问式收尾 |
| `src/engine/autoflow.js` | 投递/回复编排 | 串起以上模块，写 steps 供 UI 展示 |
| `src/engine/guard.js` | 频率与熔断 | 每小时/每日上限、冷却、连败熔断 |
| `src/engine/policy.js` | 岗位类型过滤 | 快递/外卖/保险/保健品/匿名电销 |
| `src/engine/memory.js` | 经验与策略版本 | 按问题类型计数、沉淀 lessons |
| `src/engine/knowledge.js` | 知识库读写 | 上限 240 条，去重，过滤百分比类建议 |
| `src/engine/idleLearn.js` | 空闲学习 | 搜索 → 站点内检索 → 抽取 → 模型压缩 |
| `src/engine/llm.js` | OpenAI 兼容客户端 | 多路由兜底、串行队列 |

## 运行时数据（`data/`，不入库）

| 文件 | 内容 |
| --- | --- |
| `settings.json` | 模型配置、阈值、配额、地址模板、学习节奏 |
| `resume.json` | 简历原文 / 优化版 / 解析结果 |
| `requirement.json` | 需求文本 + `prefs` |
| `versionLib.json` | 多版本简历库 |
| `memory.json` | 问题计数、经验、策略版本 |
| `knowledge.json` | 学到的职场认知 |
| `matchCache.json` | 岗位精排缓存（3 天） |
| `history.json` / `handoff.json` | 操作历史、转人工列表 |
| `backups/` | 简历写回前备份（保留 10 份） |

## 模型不可用时的降级

1. 主路由 → OFM → g4f（`chatReliable()`）；
2. 仍失败：写回复退规则稿，精排退规则分，心理分析退关键词；
3. 学习任务额外允许 Pollinations 慢速兜底；
4. 所有降级都写日志，面板能看到 `source: rule`。

## 设计取舍

- **不追求全自动无人值守**：默认只出稿不发送，自动发送要显式打开。
- **简历先结构后措辞**：模型只被允许改 bullet，防止公司/时间/职位被吃掉或串段。
- **匹配先规则后模型**：规则分保证全量覆盖且可解释，模型只在高分岗位上花预算。
- **回复先心理后文字**：先判断"他这句话想确认什么"，再决定这一层答什么、什么先别说。
