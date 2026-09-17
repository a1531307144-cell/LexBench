# LexBench · 法研台 — 设计文档

- **日期**: 2026-09-17
- **状态**: M1、M2 已实现（v1.2，含实施备注）
- **定位**: 本地优先的个人法律研究工作台 —— 检索 → 收藏 → 浏览 → 笔记 → AI 辅助，全流程一个界面完成，可发布至 GitHub 并长期迭代。

---

## 0. 实施备注（v1.1，M1 落地时对原设计的调整）

1. **数据库访问**：改用 sqlite3 标准库 + 原生 SQL，不引入 SQLAlchemy。迁移脚本成为 schema 的唯一定义，避免"ORM 模型与迁移脚本双源漂移"的维护风险，依赖更少。
2. **needs_review 守卫**：由"条文总数 < 10 或平均长度 < 20 字"改为仅"平均条文长度 < 20 字"。条文数阈值会误伤合法的节选与小法规（实测 6 条节选属正常文档）。
3. **全文检索语义**：FTS5 匹配由默认 AND 改为 OR + bm25 排序。实测发现"离婚 冷静期"用 AND 会漏掉第 1077 条——该条原文并不含"冷静期"三字（系民间俗称），部分命中必须召回。
4. **Python 版本**：设计为 3.11+，实际以 3.14 开发、代码兼容 3.10+。
5. **API 增补**：`GET /api/documents/{id}` 响应中增加 `chunks` 数组（案例/资料文档的阅读器浏览需要）。
6. **前端构建产物**：`frontend/dist` 提交入库，使非开发者克隆后无需 Node.js 即可运行。

### v1.2（M2 落地时）

1. **笔记关联的级联策略**：`notes.article_id` 外键用 `ON DELETE SET NULL` 而非 CASCADE——删除文档时笔记保留、仅解除关联，研究心血不因重导文档而丢失；`topic_items` 则 CASCADE（收藏指向不存在的法条无意义）。
2. **专题名唯一**：加 UNIQUE 索引，重名直接 409，避免列表混乱。
3. **右栏布局**：笔记面板仅在选中专题时出现，平时两栏保持阅读宽度；未做三栏拖拽调宽（M4 打磨项）。
4. **needs_review 修正**：从"结构化修正界面"简化为"阅读器内直接改条文内容 + 手动切换文档状态"，覆盖绝大多数解析误差场景，实现成本大幅降低。
5. **Markdown 预览**：引入 `marked`（约 40KB gzip）做右栏实时预览；笔记内容为用户本地输入，不做 HTML 消毒（检索摘要的 HTML 转义防注入不受影响）。

---

## 1. 项目概述

LexBench 是一个运行在本地的法律检索与研究软件：

- 用户可导入自己的 Word / PDF 法律文档（法规、案例、其他资料）；
- 通过"法条定位"或全文搜索迅速找到具体法条；
- 研究特定法律方向时，可将检索到的法条收藏到专题，边浏览边记录思考笔记；
- 集成 AI 助手（用户提供 OpenAI 兼容 API），在阅读法条时按需获取解释与相关案例，无需跳出软件。

**设计原则**

1. **本地优先**：所有文档、笔记、收藏存储在本地 SQLite，不依赖任何云服务（AI 调用除外）；
2. **代码与数据分离**：仓库只含代码与少量示例数据，用户数据目录默认 `.gitignore`；
3. **为长期迭代而设计**：模块化架构、数据库版本迁移、自动化测试、语义化版本发布；
4. **AI 可验证**：AI 回答必须标注引用法条，引用可点击跳回原文核对，防范编造条文号。

---

## 2. 核心用户场景

| # | 场景 | 对应功能 |
|---|------|---------|
| U1 | 导入桌面上的《民法典》docx，软件自动按条切分 | 文档导入 |
| U2 | 输入"民法典 1077"，直接定位到《民法典》第 1077 条 | 法条定位 |
| U3 | 输入"离婚 冷静期"，全文搜索并高亮命中 | 全文搜索 |
| U4 | 研究离婚财产分割：检索 → 收藏到专题 → 中栏逐条浏览 → 右栏记思考 | 研究工作台 |
| U5 | 读不懂某条，点"解释此条"；想找相关判例，点"找相关案例" | AI 助手 |
| U6 | 把专题连同笔记导出为 Markdown / Word 研究报告 | 专题导出 |
| U7 | 软件升级后，已有的笔记、收藏、专题完好无损 | 数据库迁移 |

---

## 3. 功能设计

### 3.1 文档导入

- **入口**: 顶部「导入文档」按钮，支持拖拽与多选；格式：`.docx`、`.pdf`；`.doc` 提示用附带脚本转换（Word COM / LibreOffice）。
- **文档三类型**，导入时自动识别、可手动修改：
  - `statute`（法规类）：按"第X条"切分为结构化法条，解析编/章/节层级；
  - `case`（案例类）：按段落切块，尝试提取案号、法院、裁判要旨等元数据（尽力而为，不强制）；
  - `other`（其他资料）：按段落切块整篇索引。
- **解析校对**: 导入后显示切分预览（条文数、首尾条文抽样）；解析失败的文档标记为"需人工检查"，M1 阶段允许删除重导，M2 增加手动修正。
- **重复检测**: 按文件内容哈希去重，重复导入给出提示。
- **批量导入**: 支持一次拖入整个文件夹（递归扫描）。

### 3.2 检索（双模式）

**模式一：法条定位**（输入框自动识别，也可手动切换）

- 识别形如 `民法典 1077`、`公司法 第51条`、`婚姻家庭编解释一 69` 的输入；
- 法规名模糊匹配（支持简写，如"民诉法"→《民事诉讼法》），条文号支持中文数字与阿拉伯数字；
- 命中则直接在中栏打开该条文；同号多条（如多部法规都有第 10 条且法规名模糊时）列出候选。

**模式二：全文搜索**

- 中文分词（jieba）+ SQLite FTS5 倒排索引；
- 结果显示：文档名 · 条号（或段落号）+ 命中片段摘要，关键词高亮；
- 筛选器：文档类型（法规/案例/其他）、部门法分类（沿用用户的目录分类：民法典、公司法、劳动法、民诉、涉外、个人信息保护等，作为文档"分类"字段，导入时可改）；
- 排序：FTS5 相关度；支持按文档聚合浏览。

### 3.3 研究工作台（核心特色）

- **专题（Topic）**: 一个研究方向对应一个专题，如"离婚财产分割"；专题列表可搜索。
- **收藏**: 检索结果/法条页一键 ★ 收藏到指定专题；同一条目可属于多个专题。
- **中栏浏览**: 专题模式下，中栏在已收藏法条间切换浏览（上一条/下一条），保持阅读上下文。
- **笔记**: 右栏 Markdown 编辑器（实时预览），每条笔记可关联：
  - 某个专题（默认）；
  - 某条具体法条（可选，显示"关联第1077条"标签，点击跳转）。
- **导出**: 专题整体导出为 Markdown / docx 研究报告——按收藏顺序列出法条全文，法条下附关联笔记。

### 3.4 AI 助手（按需调用，非聊天机器人）

**入口贴着法条**——阅读任一条文时提供三个操作：

| 操作 | 行为 |
|------|------|
| 解释此条 | 检索本地库中相关条文（同文档相邻条、其他法规关联条）作为上下文，生成通俗解释、立法背景、适用要点 |
| 找相关案例 | 三层来源按序提供：① 本地案例库中引用该条的案例（最可靠）② AI 知识（标注"AI 记忆，案号请核实"）③ 供应商联网检索（如支持，标注"联网结果"） |
| 就此条追问 | 自由输入问题，以上下文中的该条 + 检索到的相关条文为知识范围回答 |

**统一约束**：

- 任何回答先经本地法条库检索（RAG），回答末尾列"引用法条"，**点击引用跳回中栏原文**；
- API 配置：设置页填写 `base_url` + `api_key` + 模型名（OpenAI 兼容协议，DeepSeek / 通义 / Kimi 等均可）；
- 密钥仅存本地 SQLite settings 表，不进仓库、不进日志；
- AI 对话历史按"条文/专题"维度分组保存，可回看、可删除。

### 3.5 界面布局（三栏）

```
┌────────────────────────────────────────────────────────┐
│ Logo | [全文搜索/法条定位] [搜索框____________] | ＋导入 │
├──────────┬──────────────────────┬──────────────────────┤
│ 左栏      │ 中栏                  │ 右栏                  │
│ 检索结果  │ 法条/案例原文阅读      │ 研究笔记              │
│ 或       │ （面包屑：法规>编>章）  │ （Markdown 编辑）      │
│ 专题收藏  │ [解释此条][找案例][追问]│ （关联法条标签）        │
│ 列表     │ ★收藏到专题            │ AI 回答浮层           │
└──────────┴──────────────────────┴──────────────────────┘
```

- 左栏两态：搜索态（结果列表）/ 专题态（收藏列表）；
- 三栏宽度可拖拽调整；窄屏自动降级为单栏切换。

---

## 4. 技术架构

### 4.1 技术栈

| 层 | 选型 | 说明 |
|----|------|------|
| 后端 | Python 3.11+ / FastAPI | 单进程，`uvicorn` 托管 |
| 数据库 | SQLite + FTS5 | 单文件 `lexbench.db`，零配置 |
| 中文分词 | jieba | 切词后写入 FTS，查询同步切词 |
| 文档解析 | python-docx / pdfplumber | docx 优先（用户主力格式） |
| 前端 | Vue 3 + Vite + TypeScript | 构建产物由 FastAPI 静态托管 |
| AI | openai SDK（OpenAI 兼容） | Provider 抽象，见 4.6 |
| 测试 | pytest + httpx TestClient | 见第 8 节 |
| CI | GitHub Actions | push 自动跑测试 |

**启动方式**: Windows 双击 `start.bat`（创建 venv → 装依赖 → 启动服务 → 自动开浏览器）；开发者用 `make dev` / `scripts/dev.ps1` 前后端热更新。

### 4.2 目录结构

```
LexBench/
├── backend/
│   ├── app/
│   │   ├── main.py            # FastAPI 入口，挂载路由与静态资源
│   │   ├── routers/           # documents / search / workspace / ai / settings
│   │   ├── services/          # splitter(法条切分) / indexer(FTS) / retriever /
│   │   │                      # ai_provider / exporter(专题导出) / importer
│   │   ├── models/            # SQLAlchemy ORM 模型
│   │   ├── db/                # engine、migrations/
│   │   ├── core/              # 配置、中文数字转换等工具
│   │   └── schemas/           # Pydantic 请求/响应模型
│   └── tests/                 # pytest（单测 + API 集成测试）
├── frontend/
│   ├── src/
│   │   ├── views/             # Search / Reader / Workspace / Settings
│   │   ├── components/        # 三栏布局、法条卡片、笔记编辑器、AI面板…
│   │   ├── api/               # 后端接口封装
│   │   └── stores/            # Pinia 状态
│   └── (vite.config.ts)
├── scripts/                   # start.bat / dev.ps1 / convert_doc.py
├── samples/                   # 1-2 份示例法律文档（供他人克隆即用）
├── data/                      # .gitignore —— 用户文档库、lexbench.db
├── docs/                      # 本设计文档、后续 ADR
├── CHANGELOG.md
├── README.md                  # 用户视角：安装、使用、截图
└── .github/workflows/ci.yml
```

### 4.3 数据模型

```text
documents
  id, title, doc_type(statute|case|other), category, file_hash,
  original_path, status(parsed|needs_review), article_count,
  imported_at

articles                      # 法规类文档切分出的法条
  id, document_id→documents, article_label("第一千零七十七条"),
  article_no(1077, 整数), branch(编), chapter(章), section(节),
  content, order_index

chunks                        # 案例/其他资料的段落块（法规文档不生成）
  id, document_id→documents, seq, content

articles_fts / chunks_fts     # FTS5 虚拟表，存 jieba 切词后的文本

topics                        # 研究专题
  id, name, description, created_at, updated_at

topic_items                   # 专题收藏（多对多）
  id, topic_id→topics, article_id→articles, added_at, order_index

notes                         # 研究笔记
  id, topic_id→topics, article_id→articles(可空), content_md,
  created_at, updated_at

ai_messages                   # AI 对话历史
  id, scope(article:<id>|topic:<id>), role(user|assistant),
  content, citations(json), created_at

settings                      # 键值配置
  key, value                  # ai.base_url / ai.api_key / ai.model …
```

### 4.4 API 设计（REST，前缀 /api）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /documents | 上传（multipart，支持多文件） |
| GET | /documents | 列表（含类型/分类筛选） |
| GET / DELETE | /documents/{id} | 详情（含结构树）/ 删除（级联删索引） |
| POST | /documents/{id}/reparse | 改类型后重新解析 |
| GET | /search | `q, mode=auto|locate|fulltext, doc_type, category, document_id` |
| GET | /articles/{id} | 单条法条（含同文档相邻条） |
| GET/POST | /topics | 专题列表 / 新建 |
| GET/PUT/DELETE | /topics/{id} | 专题详情（含 items+notes）/ 改 / 删 |
| POST/DELETE | /topics/{id}/items | 收藏 / 移除 |
| POST/PUT/DELETE | /notes | 笔记 CRUD |
| GET | /topics/{id}/export?format=md|docx | 专题导出 |
| POST | /ai/explain | `{article_id}` |
| POST | /ai/cases | `{article_id}` |
| POST | /ai/ask | `{scope, question}` |
| GET/PUT | /settings | 读写配置（api_key 写入后不回显明文） |

### 4.5 法条切分算法

1. 逐段扫描文本（docx 段落 / pdfplumber 行）；
2. 段首匹配正则 `^第[一二三四五六七八九十百千零〇\d]+条`（含"之一/之二"后缀变体）；
3. 匹配到条头 → 开启新条文；段内出现的"依照本法第X条"**不**触发切分（只认段首）；
4. 同时识别 `第X编/章/节` 标题行，维护当前层级状态，写入条文元数据；
5. 中文数字 → 阿拉伯数字转换（支持到"一千二百六十"），存 `article_no` 供定位模式直查；
6. 切分质量守卫：条文总数 < 10 或平均长度异常（<20 字）时，文档标记 `needs_review`。

### 4.6 AI Provider 抽象

```python
class AIProvider(Protocol):
    def chat(self, messages, *, stream=True) -> Iterator[str]: ...
    def supports_web_search(self) -> bool: ...

class OpenAICompatProvider(AIProvider): ...   # 一期实现
# 未来: OllamaProvider / 其他厂商，新增文件即可，不改业务代码
```

检索编排（RAG）独立成 `Retriever` 服务：输入问题/法条 → 输出相关法条列表，AI 路由与未来任何 AI 功能共用。

### 4.7 数据流

```
docx/pdf ──importer──► 解析 ──splitter──► articles/chunks ──indexer──► FTS
                                          │
搜索框 ──► mode 判定 ─┬─ locate ──► article_no 直查 ──► 中栏
                      └─ fulltext ─► FTS 查询 ──► 左栏结果（高亮摘要）
收藏 ★ ──► topic_items ──► 中栏专题浏览 ──► 笔记 ──► notes
法条 + [AI按钮] ──► Retriever 本地检索 ──► AIProvider ──► 回答 + 引用（可点击）
```

---

## 5. 可维护性设计（长期迭代保障）

1. **模块化**：新功能 = 新增 router/service 文件，不改老代码；
2. **数据库迁移**：`db/migrations/` 版本化脚本（自带轻量迁移执行器，不引 Alembic 重依赖），启动时自动升级到最新版本——保证 U7 场景；
3. **测试安全网**：核心逻辑（数字转换、切分、检索、迁移）单测覆盖，改动有回归保障；
4. **CI**: GitHub Actions，每次 push 自动 pytest；
5. **版本发布**: 语义化版本 + CHANGELOG + GitHub Release；功能开发走 feature 分支；
6. **架构决策记录**: 重大技术决策补 ADR 文档（`docs/adr/`），未来回看有据可查；
7. **Provider 抽象**: AI 供应商可替换、可扩展本地模型。

---

## 6. 错误处理

| 情形 | 处理 |
|------|------|
| docx/pdf 解析失败 | 文档标记 `needs_review`，界面明确提示，不中断其他导入 |
| .doc 老格式 | 拒收并提示运行 `scripts/convert_doc.py`（Word COM）转换 |
| 扫描版 PDF（无文本层） | M1 检出后提示不支持（"未检出文本层"），OCR 列入 backlog |
| 法条定位无结果 | 自动降级为全文搜索并提示 |
| AI 未配置 / 调用失败 / 超时 | 按钮态明确提示原因（"未配置 API"引导去设置页），不阻塞阅读 |
| API key | 本地存储、界面不回显、日志脱敏 |

---

## 7. 测试策略

- **单测**（`backend/tests/unit/`）: 中文数字转换全覆盖（含"一千二百六十""二百零五"）；法条切分（用 `samples/` 真实文档做黄金样例）；切分守卫；查询解析（"民法典1077"等输入的解析矩阵）；
- **集成测试**（`backend/tests/api/`）: FastAPI TestClient 跑完整流程——导入 → 搜索 → 收藏 → 笔记 → 导出 → 删除；迁移测试（旧版本库升级后数据完好）；
- **前端**: 关键组件（法条卡、笔记编辑器）Vitest 冒烟测试，不追求高覆盖；
- CI 中 `pytest -q` 全绿才允许合并。

---

## 8. GitHub 发布策略

- 仓库公开，MIT License（代码），数据文件不入库；
- README：中英双语简介、截图、快速开始（克隆 → `start.bat`）、功能演示 GIF；
- `samples/` 放 1-2 份从官方渠道获取的纯文本法规（如《民法典》节选），保证克隆即可试用；
- 首个 Release: `v0.1.0`（M1 完成后），此后每个里程碑发一版。

---

## 9. 里程碑

| 阶段 | 内容 | 验收标准 |
|------|------|---------|
| **M1 检索内核** | 项目骨架、git 初始化、导入（docx/pdf、三类型、批量、去重）、法条切分、FTS 索引、双模式检索、中栏阅读、start.bat | 导入用户的真实文档库（43 docx + 2 pdf），"民法典 1077"与"离婚 冷静期"两类查询均正确返回；测试全绿 |
| **M2 研究工作台** | 专题、收藏、三栏联动、Markdown 笔记（关联法条）、专题导出 md/docx、needs_review 手动修正 | 完整走通 U4、U6 场景 |
| **M3 AI 集成** | 设置页、Provider 抽象、Retriever、三按钮（解释/案例/追问）、引用跳转、历史保存 | 任意法条的三操作可用，引用可点击核对 |
| **M4 发布打磨** | README、CI、CHANGELOG、示例数据、版本 v0.1.0 发布 | GitHub 仓库公开可用，他人克隆即可跑 |

---

## 10. 风险与对策

| 风险 | 对策 |
|------|------|
| 用户文档库含商业数据库版本内容，公开涉版权 | 代码数据严格分离；`data/` 永久 gitignore；samples 另行从官方渠道准备 |
| 法条切分遇到非常规格式（表格、脚注） | 切分守卫标记 needs_review；M2 提供人工修正；真实文档库作为测试集持续验证 |
| AI 编造条文号 | 本地 RAG 优先 + 引用可点击核对 + "AI 记忆"内容显式标注 |
| SQLite FTS5 对中文的效果不达预期 | 备选方案：FTS5 trigram tokenizer（支持子串匹配），已预研可行性，切换成本限于 indexer/retriever 两个文件 |
| .doc 老格式（6 份） | 转换脚本 + 文档说明；不阻塞主线 |

---

## 11. 二期展望（Backlog，不承诺）

- 扫描 PDF OCR 导入
- 法条新旧版本对照视图（如民法典 vs 已废止婚姻法逐条映射）
- 法条标签系统、笔记全文搜索
- 本地大模型（Ollama）Provider
- 修订追踪：标记法条现行有效/已修订状态
- 多用户 / 部署到服务器

---

## 审阅要点（请重点确认）

1. 数据模型与 API 是否满足你的使用习惯；
2. AI 三操作的划分是否符合预期；
3. 里程碑顺序（检索 → 工作台 → AI → 发布）是否认可；
4. 专题导出格式（Markdown / docx）是否都需要。
