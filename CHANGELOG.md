# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 语义化版本约定。

## [Unreleased]

### 修复

- **arXiv 限流（429）**：请求层从来没有节流，同一回合的并发工具调用会直接齐发。新增进程级请求闸
  `gateFor()`，同一上游串行执行且强制最小间隔（arXiv 3500ms，Semantic Scholar 1200ms），
  对齐 arXiv API 使用条款「每 3 秒最多 1 次、同时只允许 1 个连接」的要求
- **429 后的连击放大**：429 之前被标记为可重试，固定等 3 秒后原样重发同一条查询 —— 而 arXiv 的 429
  不带 `Retry-After`、响应体为空，重发必然再撞。现在 429 记入冷却窗口（arXiv 30s / S2 60s）并标记
  不可重试，冷却期内的后续调用由 `cooldownGuard()` 直接拒绝，一个字节都不会发往上游
- **超时被当作可重试**：复杂短语查询实测需 15–45 秒，撞 15 秒超时后重试只是再等一个超时。`TIMEOUT`
  改为不可重试，`request_timeout` 默认值 15 → 30 秒
- **退避无抖动**：`retryWaitOf()` 增加 0–50% 抖动，并发调用不会在同一毫秒齐发重试
- **arXiv 多词查询召回归零**：整段关键词原先被包成一条精确短语（`all:"a b c d e"`），词越多越难命中，
  5 词查询实测 `totalResults=0`；拆成 `AND` 项后同一查询 `totalResults=602`
- **关键词带引号导致 HTTP 400**：新增 `normalizeKeyword()`，把「用户加引号」识别为「要精确短语」的意图，
  不再当作非法输入转义进 `search_query`
- **期刊引用格式污染**：`arxiv:journal_ref` 原先整串塞进 GB/T 7714 的 `[J]` 段，输出成
  `刊名 vol. 4, no. 2, page 023066, April 2022, 2020`（卷期页码成了自由文本，年份还出现两次且互相矛盾）。
  新增 `parseJournalRef()` 结构化解析，三种格式统一使用；解析失败回退原文，不丢信息
- **缓存对并发无效**：缓存写点在网络请求之后，两次相同查询并发进来都会 cache miss。新增
  `AcademicStore.singleFlight()`，同名检索并发时只发一次上游请求
- **缓存键漏 `matchMode`**：`all` 与 `phrase` 两种查询会互相串味，现已进 key
- **面板路由未注册**：`inject` 缺 `webServer`，5 条 `/academic/ui/*` 路由从未注册，侧边面板不可用

### 变更

- 默认数据源 `semantic_scholar` → `arxiv`：S2 未鉴权时吃全体未鉴权用户共享的限流池，实测稳定 429，
  不适合做默认；需要引用数/DOI 时显式传 `source: 'both'`
- 新增配置项 `semantic_scholar_api_key`，配置项优先、缺省回退环境变量 `S2_API_KEY`（密钥不必落盘）；
  S2 搜索与详情两处请求都携带 `x-api-key`
- `academic_search` 新增 `matchMode` 参数（`all` / `phrase`），默认 `all` 保召回，关键词自带引号时自动按 `phrase`
- S2 搜索字段拆出 `S2_SEARCH_FIELDS`（不含 `abstract`），详情仍取完整字段；`fetchLimit` 由
  `max(50, n*3)` 收敛为 `max(n*2, 20)`，避免「只要 1 条也拉 50 条全文摘要」
- `resolvePaper` 在 `paperId` 分支未命中且标识非标准形态时短路，不再用同一字符串重复打上游

### 移除

- `429/5xx 一律自动退避重试一次`的旧策略：429 改为冷却 + 不可重试，仅 5xx 保留单次退避

## [0.1.2] - 2026-09-09

### 变更

- README 安装章节补充 **npm 直装方式**（方式 A，推荐）与 GitHub 源码安装（方式 B），并附验证/卸载说明
- `package.json` 补充 npm 发布元数据（`repository` / `homepage` / `bugs`）
- 使用教程 `docs/usage.md` 安装章节同步 npm 直装命令
- README 新增界面预览截图（`docs/screenshot/` 浅/深主题）

## [0.1.1] - 2026-09-08

### 修复

- 工具输出边界去除值为 `undefined` 的字段，符合宿主「无损 JSON」校验（修复 `academic_search` 等的 `value is not lossless JSON` 报错）
- 渲染回调签名对齐宿主约定 `render(args, value)`，修复检索结果渲染报错
- 客户端面板样式表未挂载导致的「全白/裸样式」问题

### 变更

- 侧边面板整体重排（统一字体与字阶、留白/对齐/按钮规范化），自动判定浅/深主题并实时跟随切换
- 导出区新增「下载文件」（`.bib` / `.md`，文件名带日期）；「复制」改用 Clipboard API 复制全文
- 新增使用教程 `docs/usage.md`，README 补充入口与导出说明
- README 新增界面预览（`docs/screenshot/` 浅/深主题截图）并修正目录结构文档

## [0.1.0] - 2026-09-06

### 新增（对应 PRD V1.0）

- **检索（功能 1）**：`academic_search` 工具，支持 arXiv / Semantic Scholar / 双源合并三种模式；关键词、作者、年份范围过滤；相关性/日期/引用数排序；真实数据源返回标题、作者、摘要、年份、DOI、期刊、引用数、PDF 链接
- **详情（功能 2）**：`academic_paper_detail` 工具，按 paperId / DOI / arXiv ID 解析单篇完整元数据，含全文摘要与全部作者
- **引用（功能 3）**：`academic_cite` 工具，本地确定性生成 GB/T 7714 / APA / BibTeX 三种格式；字段缺失占位/省略，异常回退基础格式
- **文献库（功能 4/5）**：`academic_library_add / list / remove / export` 工具；按会话隔离、内存保存；DOI/arXiv ID/标题自动去重；上限保护；BibTeX 与 Markdown 批量导出
- **侧边 UI 面板（功能 6）**：浏览器 half（`src/client.js`）经 `__ModuleLoader__` 挂载，展示文献库列表（可展开详情、移除）、检索历史、清空/导出/复制
- **防幻觉（PRD §8）**：system prompt 注入「学术文献必须经工具检索、禁止编造」约束段；检索无结果时如实告知
- **工程化**：TypeScript 源码 + tsdown 构建；严格 XML 解析器（arXiv Atom，实体转义）；HTTP 层统一超时/取消/429 退避重试；`both` 模式单源失败自动降级；配置热更新（`applies: live`）；卸载清理全部会话状态

### 修复

- 无（首版）

### 变更

- 无（首版）

## 未发布

### 规划（后续版本）

- [ ] `academic_paper_refs`：论文参考文献提取
- [ ] 文献库持久化（可选存储后端）
- [ ] 检索结果分页加载
