# 旧前端功能与交互清单

调研目录：`legacy/frontend/src`（Vue 3.5 + Vite + TS，组件式 `<script setup>`；依赖仅 vue / marked / dompurify，无 Pinia/Vuex/Router）。状态全部集中在 App.vue 的 ref 中，子组件通过 props + emits 通信，无全局 store、无路由、无 localStorage 持久化。

---

## 1. 逐组件清单

### App.vue（根组件 + 全局状态容器）
- **界面职责**：顶部 header（品牌“LexBench 法研台” + 全局搜索框 + “AI 设置”/“导入文档”两按钮）、全局错误条 `error-bar`、三栏 main 布局、全屏拖拽遮罩（“松开鼠标，导入法律文档”）、三个对话框挂载点。
- **用户操作**：
  - 搜索：输入框 Enter 或“检 索”按钮 → `doSearch()`，强制切到“检索” Tab；若后端返回 `mode === 'locate'` 且首条为 article，**自动直接打开该法条**进阅读器。
  - 打开结果/文档/法条（`openResult/openArticle/openDocument`）。
  - 删除文档（`deleteDocument`，原生 `confirm`，删除后若阅读器正显示该文档则清空）。
  - 专题 CRUD：`createTopic / renameTopic / deleteTopic / removeItem / openTopic / backToTopics`，导出 `exportTopic('md'|'docx')` = `window.open(exportTopicUrl)`。
  - 收藏入口 `openFavorite(articleId)` 打开 FavoriteDialog。
  - 条文修正保存 `saveContent(articleId, content)`：PUT 更新后**重新拉取该法条** + 刷新激活专题。
  - 全窗口拖拽导入：window 级 `dragenter/dragleave/dragover/drop` 监听，dragDepth 计数控制遮罩；drop 过滤 `\.(docx|pdf|txt|doc)$` 后塞进 `dropFiles` 并打开 ImportDialog。
- **调用的 API**：`documents、topics、topicDetail、search、article、documentDetail、deleteDocument、updateArticle、createTopic、updateTopic、deleteTopic、removeFavorite、topics(刷新)`。
- **状态**：`query/searching/searched/searchMode/results/tab/documents/reader(article|document 联合类型)/readerLoading/showImport/showSettings/dropFiles/dragging/error/topics/activeTopic/showFav/favArticleId/favArticleLabel`。`topicNav` computed：当前法条若在激活专题内，翻页用专题顺序；否则用法条自身 prev/next。

### Reader.vue（中央阅读器，双模式）
- **界面职责**：① 空态欢迎页（5 条使用提示：法条定位示例、全文搜索示例、拖拽导入、★ 收藏、AI 解读）；② **法条模式**：面包屑（title›branch›chapter›section）、条文 label 标题、“★ 收藏”/“修正”按钮、条文正文（按 `\n` 分段、首行缩进、衬线字体）、底部 category chip + **硬编码“法规” chip**、内嵌 AIPanel、底部翻页器；③ **文档模式**：文档标题、类型/分类/“需人工复查” chip、条数或段数；法规型按条列出（label + 首行前 120 字预览，点击进法条），非法规型按 chunk 分段全文展示。
- **用户操作**：收藏、进入修正编辑、保存/取消修正、点击翻页（← 上一条 / 下一条 →）、文档模式点击任意条文、法条正文点 AI 引用跳转（透传 `open-article`）。
- **API**：不直接调用（数据由 App 传入）。
- **状态**：`editing/draft/saving`；`watch(props.state)` 变化时滚动 `.reader-pane` 回顶部并退出编辑态。

### ResultList.vue（左侧“检索” Tab）
- **界面职责**：空态两套文案（库空 → 引导导入；已搜索 → 示例）；“检索中…”；无结果提示；结果列表：模式 chip（“法条定位”高亮 / “全文搜索”）+ 原始 query、每条结果（标题、类型 chip 按 `data-type` 着色、条文 label、**`v-html` 渲染 snippet 高亮摘要**，配合全局 `em` 样式实现关键词高亮）。当前打开的 article 高亮 `selected`。
- **用户操作**：点击结果（article → 打开法条，其它 → 打开所属文档）。
- **API**：无（纯展示）。
- **状态**：全 props（results/mode/searched/searching/query/selectedId/hasDocs）。

### DocLibrary.vue（左侧“文档库” Tab）
- **界面职责**：空态引导；文档行：标题 + “需复查”黄 chip、类型 chip、分类、条数（仅法规型）、导入日期；悬停变边框；行尾 ✕ 删除按钮。
- **用户操作**：点击行打开文档阅读、✕ 删除（App 里原生 confirm）。
- **API**：无（纯展示）。
- **状态**：全 props。

### TopicPanel.vue（左侧“专题” Tab，列表/详情双态）
- **界面职责**：
  - 列表态：头栏“研究专题”+“+ 新建/取消”；内联创建表单（名称必填 + 一句话描述可选）；空态提示；专题行（名称、描述、“N 条 · N 记”、✕ 删除）。
  - 详情态：头栏“‹ 返回”+ 专题名 + “导出 .md / 导出 .docx”；**双击描述行进入重命名**（无描述时显示“（双击此处重命名）”提示）；收藏条目列表（序号 = `order_index+1`、条文 label、所属文档标题、40 字摘要、悬停显隐 ✕ 移出），当前打开的条文高亮 `active`。
- **用户操作**：新建/重命名/删除专题、打开专题、返回、点击条目跳法条、移出条目、两种格式导出。
- **API**：无直接调用（全部经 App）。
- **状态**：`newName/newDesc/creating/renaming/renameValue`。

### NotePanel.vue（右侧笔记栏，仅当 `activeTopic` 存在时 `v-if` 渲染）
- **界面职责**：头栏（专题名 + .md/.docx 导出按钮）；Markdown 编辑器（工具栏：“记思考/编辑笔记” + **“关联〔当前条文 label〕”复选框**（仅当前法条已收藏进本专题时显示）+ 编辑/预览切换）；Ctrl+Enter 快捷保存；笔记卡片列表（关联条文 chip 可点击跳转 / “专题” chip、更新时间 `slice(5,16)`、✎ 编辑、✕ 删除、60 字纯文本摘要）。
- **用户操作**：写笔记（可选关联当前法条）、预览 Markdown、编辑已有笔记（进入编辑器复用同一表单）、删除笔记（原生 confirm）、跳转关联法条、导出。
- **API**：**直接调用** `api.createNote / updateNote / deleteNote`（是唯一绕过 App 直接发请求的组件之一），完成后 `emit('changed')` 让 App 刷新专题。
- **状态**：`content/editingId/linkCurrent/preview/busy/error`；`watch(currentArticleId)` 切换法条时 `linkCurrent` 重置为 true；`previewHtml` 用 marked 渲染（**未经 DOMPurify**）。

### AIPanel.vue（阅读器内嵌 AI 助手，仅法条模式）
- 详见第 3 节。

### ImportDialog.vue（导入对话框，Teleport 到 body）
- 详见第 4 节。

### FavoriteDialog.vue（收藏对话框，Teleport）
- **界面职责**：标题“收藏 {label}”；单选已有专题列表（名称 + “N 条 · N 记”）或“+ 新建专题”内联输入（Enter 直接收藏）；成功/错误消息；底部“取消”/“★ 收藏”。
- **用户操作**：选专题或新建并收藏；打开时拉取专题列表，库中无专题时自动进入新建态并默认选中第一个。
- **API**：`api.topics、api.createTopic、api.addFavorite`；成功后等 **500ms**（让用户看到“已收藏 ××”或“该法条已在此专题中”）再 `emit('done')` 关闭。
- **状态**：`topics/selected/creating/newName/busy/message`。

### SettingsDialog.vue（AI 设置对话框，Teleport）
- 详见第 3 节。

### api.ts（API 层 + 全部类型定义）
- `request<T>()` 封装 fetch：非 2xx 时解析 `body.detail`（FastAPI 风格）抛 `Error(detail || '请求失败（status）')`。
- 完整端点清单见第 7 节；类型：ArticleBrief/ArticleDetail/ArticleRow/ChunkRow/DocumentDetail/DocumentRow/SearchResult/SearchResponse/ImportResult/TopicRow/TopicItemRow/NoteRow/TopicDetail/AISettings/Citation/AIMessage。

---

## 2. 三栏布局与 Tab 切换逻辑

- **布局**：`header(58px)` → `main(flex)` = 左侧 `side(340px 固定, border-right)` + 中央 `reader-pane(flex:1, 自身 overflow-y:auto, 内容 max-width 780px 居中)` + 右侧 `NotePanel(320px 固定, border-left, v-if="activeTopic")`。**右栏不是常驻第三栏**——只有打开某专题后才出现；关闭专题（`backToTopics` 或删除）右栏消失，阅读器占满剩余宽度。
- **Tab 切换**：单 ref `tab: 'results' | 'topics' | 'library'`；三个按钮直接赋值，三个面板用 **`v-show`**（非 v-if）保持挂载、保留滚动位置与内部状态。每个 Tab 标题带数量徽标：检索（仅 `searched` 后显示结果数）、专题（`topics.length`）、文档库（`documents.length`）。
- **联动**：`doSearch()` 无条件 `tab.value = 'results'`；阅读器状态独立于 Tab（Tab 只影响左栏面板）；`selectedId()`（当前打开的法条 id）同时传给 ResultList（高亮选中项）和 TopicPanel/NotePanel（高亮/关联判断）。

## 3. AI 面板交互细节

- **入口与归档**：仅法条模式渲染；按 `articleId` 归档，`watch(articleId, loadHistory, {immediate})` 切法条即拉取 `GET /api/ai/history?article_id=`。顶栏注明“问答仅存本机，按条文归档”。
- **三种动作**：✦ 解读本条（`POST /api/ai/explain`）、⚖ 找案例（`POST /api/ai/cases`）、底部输入框追问（`POST /api/ai/followup {article_id, question}`，Enter 或按钮触发）。互斥 busy 状态（`busy: ''|'explain'|'cases'|'followup'`）禁用所有按钮与输入框；按钮文案变“解读中…/检索中…/思考中…”。
- **“流式”显示——实为无流式**：旧版**没有** SSE/流式渲染，只有静态提示行“AI 生成中，通常需要几秒到几十秒…”，响应整体返回后一次性 push 进列表并滚动到该消息（`reveal()`：先 scrollTo 底部，再对该消息 `scrollIntoView smooth`，两次滚动叠加冗余）。**流式输出是新 UI 的明确改进机会**。
- **配置缺失引导**：`handleError` 用正则 `/未配置|API Key|接口地址/` 匹配错误文案 → 显示黄色提示条 + “去设置”按钮 → 一路 emit 到 App 打开 SettingsDialog。
- **消息卡片**：action 徽标（解读/案例/追问三色）、追问问题截断 30 字、时间 `slice(5,16)`、✕ 删除（confirm → `DELETE /api/ai/messages/{id}`，本地过滤）。
- **Markdown + 引用双链**：
  - 正文 `marked` 渲染后，遍历 `msg.citations`，把正文中出现的 `escapeHtml(c.cite_text)` 全局替换为 `<a class="cite-link" data-article-id="{id}">`；容器级 `@click` 委托（`closest('a.cite-link')`）→ `emit('open-article', id)` → Reader 透传 → App.openArticle 重新拉取法条。整链路经 DOMPurify 消毒（AIPanel 是全应用唯一用 DOMPurify 的地方）。
  - 卡片底部独立“引用：”chip 区：`article_id` 非空可点击跳转；为空的显示“{title}{label}（库内未收录）”、置灰禁用、tooltip“库内未找到该条文，仅供文字参考”。
- **设置对话框（SettingsDialog.vue）字段与流程**：
  - 字段：① 接口地址 base_url（placeholder “如：https://api.deepseek.com/v1”）；② 模型名（如 deepseek-chat）；③ API Key（type=password、autocomplete=off；已配置时标签旁显示掩码 `api_key_masked`，placeholder “留空表示不修改”）。顶部提示：支持 OpenAI 兼容协议（DeepSeek/通义/Kimi/OpenAI），Key 仅存本机 data/ 目录。
  - 打开时 `GET /api/ai/settings` 回填；保存 = `PUT /api/ai/settings`（key 留空则不携带该字段），保存后**再拉一次** settings 刷新掩码。
  - **测试连接**：`POST /api/ai/test`（**无请求体**）→ 成功显示“连接正常：{reply}”。注意：测试的是**后端已保存**的配置，不是表单里刚改未存的值——用户必须先保存再测试，这是一个交互陷阱（见第 6 节）。
  - 保存/测试进行中禁止关闭对话框。

## 4. 导入对话框（ImportDialog.vue）

- **两种添加方式**：① 点 drop-zone 打开原生文件选择器（`input accept=".docx,.pdf,.txt,.doc" multiple`）；② 对话框内拖拽（dragover 高亮、drop 收集）。另有 App 级全窗口拖拽：文件先落到 `dropFiles`，打开对话框时通过 `initialFiles` 预填。
- **类型选择（法规/案例/其他）——旧版没有用户可选的类型控件**：仅一个自由文本“分类（可选）”输入框（placeholder“如：民法典、公司法、劳动法”），`doc_type`（statute/case/other）由**后端自动识别**。若新 UI 想让用户手动指定类型，属于新增能力。
- **文件列表**：文件名 + KB 大小 + ✕ 移除；无去重、无大小/数量上限提示。
- **进度与错误**：无逐文件进度条、无百分比——只有一个全局“导入中…”按钮态（`uploading` 禁关禁重）。完成后展示逐文件结果行，三态着色：`imported`“已导入”（法规显示“N 条”，其它显示“已分块索引”）、`duplicate`“重复，已跳过”（黄）、`failed`“失败”（红，带 message）；整体请求失败则伪造一条 failed 结果展示。副文案注明“.doc 老格式请先用转换脚本”（但过滤器仍接受 .doc）。
- 上传成功后 `emit('uploaded')` → App `refreshDocs()`。

## 5. 条文修正的交互与保存链路

1. 阅读器法条模式点“修正” → `startEdit()`：draft 载入当前 content，进入 textarea 编辑态（衬线字体、可纵向拉伸），提示文案“修正解析错误的条文内容，保存后全文索引同步更新”，按钮“取消 / 保存修正”（空内容禁用）。
2. `saveEdit()` → `emit('save-content', articleId, draft.trim())` → App.`saveContent()`：
3. `PUT /api/articles/{id}` body `{content}`（后端应同步重建全文索引）→ 成功后 `openArticle(articleId)` 重新 GET 该法条刷新阅读器（同时天然退出编辑态并滚回顶部）→ 若该法条在某激活专题内，`refreshActiveTopic()` 同步专题摘要 → 如有失败则显示在 App 全局错误条。
4. 状态变化时 `watch(state)` 统一清编辑态；无成功 toast、无修改前后 diff、无撤销。

## 6. UX 缺陷 / TODO / Bug（新 UI 改进机会）

代码中无显式 TODO/FIXME/console 标记；以下为行为层面的发现：

**确定的 bug**
1. **Reader.saveEdit 的 saving 状态失效**（Reader.vue:57-67）：`emit` 是同步的，`finally { saving.value = false }` 立即执行，“保存中…”永远不显示、按钮立刻恢复可点，与真实网络请求不同步。
2. **`api.updateDocumentStatus`（PUT /api/documents/{id}/status）是死代码**：api.ts 里定义了但全应用无任何调用——文档状态 `needs_review` 只能看不能改，“标记已复查”功能缺失。
3. **`aiFollowup` 的 `topic_id` 分支未使用**：类型支持专题级追问，UI 只传 `article_id`——专题级 AI 问答是未完成的能力。
4. **App.deleteDocument / removeItem / NotePanel.remove 无 try/catch**：请求失败成为 unhandled rejection，全局错误条不显示。
5. **Reader 条文底部硬编码 `<span class="foot-chip">法规</span>`**（Reader.vue:136）：若未来条文可来自案例/资料类文档则显示错误。
6. **window 级 `dragover`/`drop` 匿名监听未在 onBeforeUnmount 注销**（App.vue:252-256 只移除了 dragenter/dragleave）。
7. **拖拽与对话框双重处理**：ImportDialog 打开时再拖文件，App 的 window drop 监听仍会触发（覆盖 dropFiles），语义混乱。

**XSS / 一致性风险**
8. **ResultList `v-html="r.snippet"` 不消毒**（ResultList.vue:61）——完全信任后端转义，与 AIPanel（用 DOMPurify）标准不一致。
9. **NotePanel 预览 `v-html` 用 marked 渲染但不用 DOMPurify**（NotePanel.vue:39-41,126）——仅自伤型 XSS，但同样是标准不一致。

**交互/UX 缺陷**
10. **SettingsDialog 测试连接测的是已保存配置而非表单当前值**，用户改完不保存直接测试会得到误导性结果。
11. **编辑中丢失无保护**：`watch(state)` 任何阅读器切换（包括点 AI 引用跳转）直接丢弃未保存的修正草稿和未保存的笔记草稿，无确认。
12. **重命名专题的入口是“双击描述行”**——隐蔽到需要在文案里写“（双击此处重命名）”；且 `updateTopic` API 支持 description 但 UI 无任何编辑描述的入口。
13. **搜索模式不可控**：后端支持 mode 参数但 UI 无 手动切换“定位/全文”的开关，看起来像条文号的查询无法强制走全文搜索。
14. **导入无逐文件进度**（只有整体转圈）、上传成功后文件列表不清空（可一键再传制造重复）、无大小/数量限制提示、拖入不支持的扩展名静默无反馈。
15. **FavoriteDialog 硬编码 500ms 延迟**展示成功消息；“先建专题后收藏失败”会留下孤儿专题（重试再建）。
16. **专题条目不可排序/拖拽**（数据模型有 `order_index` 但 UI 无重排）。
17. **NotePanel 摘要用正则 `[#>*\`\-]` 剥离 markdown**——把正文里的连字符/日期也剥掉，且不进编辑态无法看笔记全文渲染结果。
18. **AI 无流式输出**（见第 3 节）+ `reveal()` 双重滚动；历史加载失败静默清空消息（`catch { messages.value = [] }`）。
19. **全局错误条不可手动关闭**；`refreshDocs/refreshTopics` 失败显示 `String(e)`（形如 "TypeError: ..." 原始文本）。
20. **原生 `confirm()`/`alert` 交互**（删除文档/专题/笔记/AI 记录）与整体对话框风格割裂，Electron 环境下观感尤差。
21. **无路由/无状态持久化**：刷新（或窗口重载）丢失阅读器与 Tab 状态；条目行、结果行均为 div click，无键盘可达性（tabindex/Enter）。
22. **文档模式无文内跳转/文内搜索**，长法规只能滚动或逐条点击。
23. **导出 `window.open(url)`** 依赖浏览器处理 Content-Disposition，导出失败时只会打开一个错误页，无前端反馈。

## 7. api.ts 完整端点清单

| # | 方法 + 路径 | 请求 | 响应 | UI 调用方 |
|---|---|---|---|---|
| 1 | `GET /api/search?q=&mode=` | mode 默认 'auto'（服务端判定 locate/fulltext） | `SearchResponse {mode, query, results[]}` | App.doSearch |
| 2 | `GET /api/documents` | — | `DocumentRow[]` | App.refreshDocs |
| 3 | `GET /api/documents/{id}` | — | `DocumentDetail`（含 articles[] + chunks[]） | App.openDocument |
| 4 | `POST /api/documents` | multipart：`files[]` + `category` | `{results: ImportResult[]}`（status: imported/duplicate/failed） | ImportDialog.upload |
| 5 | `DELETE /api/documents/{id}` | — | `{ok}` | App.deleteDocument |
| 6 | `PUT /api/articles/{id}` | `{content}` | `{ok}` | App.saveContent（条文修正） |
| 7 | `PUT /api/documents/{id}/status` | `{status}` | `{ok}` | **无调用方（死代码）** |
| 8 | `GET /api/topics` | — | `TopicRow[]`（含 item_count/note_count） | App.refreshTopics、FavoriteDialog |
| 9 | `POST /api/topics` | `{name, description?}` | `TopicRow` | App.createTopic、FavoriteDialog |
| 10 | `GET /api/topics/{id}` | — | `TopicDetail`（items[] + notes[]） | App.openTopic/refreshActiveTopic |
| 11 | `PUT /api/topics/{id}` | `{name?, description?}` | `{ok}` | App.renameTopic（**description 更新无 UI 入口**） |
| 12 | `DELETE /api/topics/{id}` | — | `{ok}` | App.deleteTopic |
| 13 | `POST /api/topics/{id}/items` | `{article_id}` | `{status: added/duplicate, item_id}` | FavoriteDialog.confirm |
| 14 | `DELETE /api/topics/{id}/items/{articleId}` | — | `{ok}` | App.removeItem |
| 15 | `POST /api/notes` | `{topic_id, article_id?, content_md}` | `NoteRow` | NotePanel.save |
| 16 | `PUT /api/notes/{id}` | `{content_md}` | `{ok}` | NotePanel.save（编辑态） |
| 17 | `DELETE /api/notes/{id}` | — | `{ok}` | NotePanel.remove |
| 18 | `GET /api/topics/{id}/export?format=md\|docx` | （仅拼 URL，`window.open` 下载，非 fetch） | 文件流 | App.exportTopic |
| 19 | `GET /api/ai/settings` | — | `AISettings {base_url, model, api_key_set, api_key_masked}` | SettingsDialog（打开时 + 保存后） |
| 20 | `PUT /api/ai/settings` | `{base_url, model, api_key?}`（key 留空不带） | `{ok}` | SettingsDialog.save |
| 21 | `POST /api/ai/test` | 无请求体（测后端已存配置） | `{ok, reply}` | SettingsDialog.testConn |
| 22 | `POST /api/ai/explain` | `{article_id}` | `AIMessage` | AIPanel.run('explain') |
| 23 | `POST /api/ai/cases` | `{article_id}` | `AIMessage` | AIPanel.run('cases') |
| 24 | `POST /api/ai/followup` | `{article_id? \| topic_id?, question}` | `AIMessage` | AIPanel.ask（**仅用 article_id**） |
| 25 | `GET /api/ai/history?article_id=` | — | `AIMessage[]` | AIPanel.loadHistory |
| 26 | `DELETE /api/ai/messages/{id}` | — | `{ok}` | AIPanel.remove |

AIMessage 结构：`{id, article_id, topic_id, action: 'explain'|'cases'|'followup', question, answer_md, citations: Citation[], created_at}`；Citation：`{article_id|null, title, label, cite_text}`（article_id 为 null 表示库内未收录的引用）。

**新 UI 需保留的全部既有功能面**：法条定位+全文双模搜索（locate 自动直达）、法规/案例/资料三型文档库与需复查标记、条文修正+索引同步、专题（收藏/排序/去重/导出 md+docx）、关联条文的 Markdown 笔记（预览+快捷键）、条文级 AI 三动作（解读/找案例/追问）+ 引用双链跳转 + 按条文归档历史、OpenAI 兼容设置（掩码 Key + 测试连接）、全窗口拖拽导入。明确缺失可补：流式 AI、文档状态修改、专题级 AI 追问、描述编辑、条目重排、导入进度、搜索模式切换。