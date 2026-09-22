已完成全部文件的只读调研（44 个文件，核心源码全部读取）。以下为规格书全文。

---

# 《LexBench 后端领域规格书》（legacy/backend 移植用）

调研范围：`legacy/backend`（FastAPI + SQLite，只读调研，未修改任何文件）

## 0. 总览

- 技术栈：Python 3 / FastAPI / uvicorn / sqlite3（标准库驱动，非 ORM）/ jieba / python-docx / pdfplumber / httpx；桌面模式加 pywebview + PyInstaller
- requirements.txt：`fastapi>=0.115, uvicorn[standard]>=0.30, python-docx>=1.1, pdfplumber>=0.11, jieba>=0.42, python-multipart>=0.0.9, pytest>=8, httpx>=0.27`
- requirements-desktop.txt：`pywebview>=6, pyinstaller>=6.14, pillow>=11`
- 目录结构：`app/main.py`（装配）、`app/core/{config,cn2num}.py`、`app/db/{connection,migrations/001~003}.py`、`app/routers/{documents,search,workspace,ai}.py`、`app/services/{importer,indexer,splitter,search,retriever,ai_provider,exporter}.py`、`app/desktop.py`
- 三个里程碑对应三批迁移：M1 导入/检索（001）、M2 研究工作台（002）、M3 AI 助手（003）

---

## 1. 数据库 Schema

### 迁移机制（app/db/connection.py 全文要点）

- `connect(db_path)`：`sqlite3.connect(db_path, check_same_thread=False)`，执行 `PRAGMA foreign_keys = ON`，`row_factory = sqlite3.Row`（单连接全局共享）
- `init_db(db_path)`：读 `PRAGMA user_version`；遍历 `migrations/` 下按文件名数字前缀排序的 `.sql`，版本号 > 当前版本则 `executescript` 全文执行并 `user_version = N` 后 commit。DB 路径父目录自动 mkdir

### 001_init.sql 全文

```sql
-- 001_init: M1 基础表 —— documents / articles / chunks / settings + FTS5 索引表
-- (M2 将新增 topics / topic_items / notes；M3 新增 ai_messages)

CREATE TABLE IF NOT EXISTS documents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    doc_type      TEXT NOT NULL DEFAULT 'other',   -- statute | case | other
    category      TEXT NOT NULL DEFAULT '',        -- 部门法分类，如"民法典"、"劳动法"
    file_hash     TEXT NOT NULL UNIQUE,
    original_path TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'parsed',  -- parsed | needs_review
    article_count INTEGER NOT NULL DEFAULT 0,
    imported_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    article_label TEXT NOT NULL,                   -- "第一千零七十七条"
    article_no   INTEGER NOT NULL,                 -- 1077
    branch       TEXT NOT NULL DEFAULT '',         -- 编
    chapter      TEXT NOT NULL DEFAULT '',         -- 章
    section      TEXT NOT NULL DEFAULT '',         -- 节
    content      TEXT NOT NULL,
    order_index  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_doc ON articles(document_id, order_index);
CREATE INDEX IF NOT EXISTS idx_articles_no  ON articles(article_no);

CREATE TABLE IF NOT EXISTS chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    content     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id, seq);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 全文索引表：content 列存 jieba 切词后的文本（空格分隔），检索时查询词同样切词
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    article_id UNINDEXED,
    content
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    content
);
```

### 002_research.sql 全文

```sql
-- 002_research: M2 研究工作台 —— topics / topic_items / notes
-- 设计对应：专题收藏（多对多）、Markdown 笔记（可关联法条）

CREATE TABLE IF NOT EXISTS topics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_name ON topics(name);

CREATE TABLE IF NOT EXISTS topic_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id    INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,                        -- 收藏顺序，专题浏览/导出按此排序
    added_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE(topic_id, article_id)                         -- 同一专题内不重复收藏
);
CREATE INDEX IF NOT EXISTS idx_topic_items_topic ON topic_items(topic_id, order_index);

CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id    INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    article_id  INTEGER REFERENCES articles(id) ON DELETE SET NULL,  -- 可空；法条被删时笔记保留、仅解除关联
    content_md  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(topic_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_article ON notes(article_id);
```

### 003_ai.sql 全文

```sql
-- 003_ai: M3 AI 助手 —— ai_messages（按条文/专题分组保存对话历史）
-- 密钥不在此表：ai_base_url / ai_api_key / ai_model 存于 settings 表（本地 data/，不入库）

CREATE TABLE IF NOT EXISTS ai_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id  INTEGER REFERENCES articles(id) ON DELETE CASCADE,
    topic_id    INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    action      TEXT NOT NULL,                     -- explain | cases | followup
    question    TEXT NOT NULL DEFAULT '',
    answer_md   TEXT NOT NULL,
    citations   TEXT NOT NULL DEFAULT '[]',        -- JSON: [{article_id, title, label}]
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    CHECK (article_id IS NOT NULL OR topic_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_article ON ai_messages(article_id, id);
CREATE INDEX IF NOT EXISTS idx_ai_messages_topic ON ai_messages(topic_id, id);
```

要点：FTS5 表用默认 unicode61 tokenizer，但**入库/查询文本都先经 jieba 切词再空格拼接**（见 §4）；`articles_fts.article_id`/`chunks_fts.chunk_id` 为 UNINDEXED；settings 表存 `ai_base_url / ai_api_key / ai_model`（迁移 003 注释明确：密钥只进本地 data/ 的 settings，不进代码、不进日志）。

---

## 2. 文档导入器 services/importer.py

**结果模型**：`ImportResult(status, title, document_id=0, doc_type="", article_count=0, message="")`，status ∈ `imported | duplicate | failed`。

**标题清洗**：`_DATE_SUFFIX_RE = re.compile(r"[_\s\-]\d{4,8}$")`——去掉文件名 stem 尾部的日期后缀（如 `民法典_20210101` → `民法典`），清洗后为空则用原 stem。

**内容哈希去重**：`_sha256` 分块（1MB）读文件算 SHA-256；先查 `documents.file_hash`，命中即返回 `duplicate`（带已存在 document_id），完全不重复解析。file_hash 列有 UNIQUE 约束兜底。

**三种格式解析**：
- **docx**：python-docx `Document(str(path))`，取 `doc.paragraphs` 中 `p.text.strip()` 非空的段落。**注意：只读段落，表格/页眉页脚内容会丢失**。
- **pdf**：pdfplumber `pdfplumber.open(path)`，逐页 `page.extract_text() or ""` 按 `splitlines()` 拆行、strip、去空。若全部段落总字符数 `< 20`，返回 failed，message=`"未检出文本层（可能是扫描版 PDF），暂不支持 OCR"`。无任何额外参数（无密码、无裁剪、无 OCR）。
- **txt**：读原始 bytes，按顺序尝试 `utf-8-sig` → `gb18030` 解码，都失败则 `utf-8, errors="replace"` 兜底；按行 strip 去空。
- **.doc** 老格式直接拒绝：message=`"不支持 .doc 老格式，请先运行 scripts/convert_doc.py 转为 .docx"`；其它后缀 failed `"不支持的文件类型 X"`；解析抛异常 failed `"解析失败：{e}"`（单文件失败不阻断批量导入）；解析出 0 段 failed `"文档内容为空"`。

**类型判定与“需复查”**（调 splitter，见 §3）：`detect_doc_type` 判 `statute/case/other`。若 statute：`split_statute` 切条；`status = "needs_review"` 当且仅当**没切出任何条，或平均条内容长度 < `_MIN_AVG_ARTICLE_LEN = 20` 字**；否则 `parsed`。case/other 恒为 parsed。

**入库流程**：`INSERT INTO documents(title, doc_type, category, file_hash, original_path, status)` → commit 拿 doc_id → statute 走 `index_articles`（写 articles + articles_fts + 回填 article_count），否则 `chunk_paragraphs(paragraphs, target=500)` 后 `index_chunks`。**分块算法**：贪心累积段落，累计字符数 ≥500 就封一块（`\n` join），尾段独立成块；单段超长不内部再切。最后 `shutil.copy2` 原件到 `files_dir/<sha256><原后缀>`。

**移植注意**：documents INSERT 先 commit，之后索引失败会留下“有文档无法条”的半成品；导入接口层（documents.py）先落盘到 `files_dir/tmp/<uuid><suffix>` 再交给 importer，finally 里删临时文件。

---

## 3. 条文切分与中文数字（核心算法，全文）

### app/core/cn2num.py 全文

```python
_DIGITS = {
    "零": 0, "〇": 0,
    "一": 1, "二": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}
_UNITS = {"十": 10, "百": 100, "千": 1000}


def cn2num(s: str):
    """中文数字（≤9999，含零/〇占位）或阿拉伯数字字符串转 int；无法解析返回 None。"""
    if not s:
        return None
    if s.isdigit():
        return int(s)
    total = 0
    current = 0
    for ch in s:
        if ch in _DIGITS:
            current = _DIGITS[ch]
        elif ch in _UNITS:
            if current == 0:
                current = 1  # "十" 独立成词表示 10
            total += current * _UNITS[ch]
            current = 0
        else:
            return None
    return total + current
```

算法说明：逐字符状态机，遇数字更新 `current`，遇单位乘入 `total`；`current==0` 遇单位按 1 处理（“十”=10、“十三”=13）；含未知字符（含“万”）返回 None。支持零/〇 占位（如 一千零七十七）。上限 9999（无“万”）。

### app/services/splitter.py 全文

```python
import re
from dataclasses import dataclass

from app.core.cn2num import cn2num

_NUM = r"[零〇一二三四五六七八九十百千\d]+"
ARTICLE_RE = re.compile(rf"^第({_NUM})条(之[一二三四五六七八九十])?\s*")
BRANCH_RE = re.compile(rf"^第({_NUM})编\s*\S")
CHAPTER_RE = re.compile(rf"^第({_NUM})章\s*\S")
SECTION_RE = re.compile(rf"^第({_NUM})节\s*\S")
CASE_NO_RE = re.compile(r"[（(]\s*\d{4}\s*[）)].{0,20}?号")
_CASE_TEXT_RE = re.compile(r"判决书|裁定书|裁判要旨|仲裁裁决")
_STATUTE_MIN_ARTICLES = 3


@dataclass
class Article:
    label: str = ""
    no: int = 0
    branch: str = ""
    chapter: str = ""
    section: str = ""
    content: str = ""
    order_index: int = 0


def split_statute(paragraphs):
    """把法规文档段落切分为法条列表；编/章/节标题行更新层级状态。"""
    articles = []
    current = None
    branch = chapter = section = ""
    for raw in paragraphs:
        p = raw.strip()
        if not p:
            continue
        m = ARTICLE_RE.match(p)
        if m:
            if current is not None:
                articles.append(current)
            current = Article(
                label=f"第{m.group(1)}条{m.group(2) or ''}",
                no=cn2num(m.group(1)) or 0,
                branch=branch,
                chapter=chapter,
                section=section,
                content=p[m.end():].strip(),
            )
            continue
        if BRANCH_RE.match(p):
            branch = p
            chapter = section = ""
        elif CHAPTER_RE.match(p):
            chapter = p
            section = ""
        elif SECTION_RE.match(p):
            section = p
        elif current is not None:
            current.content += "\n" + p
    if current is not None:
        articles.append(current)
    for i, a in enumerate(articles):
        a.order_index = i
    return articles


def detect_doc_type(paragraphs):
    """识别文档类型：statute | case | other。"""
    article_starts = sum(1 for p in paragraphs if ARTICLE_RE.match(p.strip()))
    if article_starts >= _STATUTE_MIN_ARTICLES:
        return "statute"
    text = "\n".join(paragraphs)
    if CASE_NO_RE.search(text) or _CASE_TEXT_RE.search(text):
        return "case"
    return "other"
```

状态机说明：
- `ARTICLE_RE` 必须**行首**匹配 `第X条`（X 允许中文数字/阿拉伯数字/零〇），可选 `之一/之二…` 后缀（label 保留原文如“第一千零七十七条之一”）；`article_no = cn2num || 0`（解析失败记 0）；条内容 = 匹配结束后的同行剩余文字。
- 编/章/节行要求 `第X编` 后**同跟非空白字符**（`^\s*\S`，即标题文字），整行存入 branch/chapter/section；进入新编会清空 chapter/section，新章清空 section。
- 条前导言（未遇任何条之前的段落）被丢弃；条与条之间的续段用 `\n` 追加到 current.content。
- case 判定：案号模式 `[（(]\d{4}[）)]` 后 0-20 字符内出现 `号`，或文本含 判决书/裁定书/裁判要旨/仲裁裁决。

---

## 4. 检索（search.py / indexer.py / retriever.py）

### indexer.py（分词与索引）

- 分词库：**jieba**（精确模式 `jieba.cut`），`jieba.setLogLevel(60)` 静默。`tokenize(text)` = jieba 切词后仅保留 `^\w+$`（Unicode）的词，空格 join。**索引与查询共用同一规则**，配合 FTS5 默认 unicode61 tokenizer（按空格分 token）。
- `index_articles`：逐条 INSERT articles + articles_fts（content 存 tokenize 后文本），完成后 `UPDATE documents SET article_count=?`，commit。
- `index_chunks`：INSERT chunks(seq=下标) + chunks_fts，commit。
- `reindex_article(article_id)`：DELETE articles_fts WHERE article_id → 重新 INSERT（手动改条文后调用）。**FTS 行不随外键级联，须手动删**。
- `remove_document_content`：按子查询删两套 FTS 行，再删 articles、chunks，commit。

### search.py 全文（核心）

```python
import html
import re
from dataclasses import dataclass

import jieba

from app.core.cn2num import cn2num

jieba.setLogLevel(60)

_ARTICLE_RE = re.compile(r"第\s*([零〇一二三四五六七八九十百千\d]+)\s*条")
_TRAILING_NUM_RE = re.compile(r"(\d{1,5})\s*$")
_TOKEN_RE = re.compile(r"^\w+$", re.UNICODE)


@dataclass
class LocateQuery:
    hint: str
    article_no: int


def parse_locate_query(q: str):
    """解析法条定位查询："民法典 1077" / "公司法 第51条" → (法规名提示, 条号)。

    无法定位（无条号）时返回 None。
    """
    q = (q or "").strip()
    if not q:
        return None
    m = _ARTICLE_RE.search(q)
    if m:
        no = cn2num(m.group(1))
        if no is None:
            return None
        hint = (q[: m.start()] + q[m.end():]).strip()
        return LocateQuery(hint=hint, article_no=no)
    m = _TRAILING_NUM_RE.search(q)
    if m:
        hint = q[: m.start()].strip()
        return LocateQuery(hint=hint, article_no=int(m.group(1)))
    return None


def _is_subsequence(hint: str, title: str) -> bool:
    it = iter(title)
    return all(ch in it for ch in hint)


def match_documents(conn, hint: str):
    """按法规名提示匹配法规文档：子串命中优先，其次子序列（支持"民诉法"式简写）。"""
    rows = conn.execute(
        "SELECT id, title FROM documents WHERE doc_type='statute' ORDER BY id"
    ).fetchall()
    if not hint:
        return [r["id"] for r in rows]
    exact, fuzzy = [], []
    for r in rows:
        title = r["title"]
        norm = title.replace("中华人民共和国", "")
        if hint in title or hint in norm:
            exact.append(r["id"])
        elif _is_subsequence(hint, title):
            fuzzy.append(r["id"])
    return exact + fuzzy


def search_locate(conn, query, limit=20):
    """法条定位：解析查询 → 匹配法规 → 按 article_no 精确取条。"""
    q = parse_locate_query(query) if isinstance(query, str) else query
    if q is None:
        return []
    doc_ids = match_documents(conn, q.hint)
    if not doc_ids:
        # 提示词匹配不到任何法规时，退化为在所有法规中按条号找
        doc_ids = [
            r[0] for r in conn.execute("SELECT id FROM documents WHERE doc_type='statute'")
        ]
    if not doc_ids:
        return []
    placeholders = ",".join("?" * len(doc_ids))
    rows = conn.execute(
        f"""SELECT a.id, a.document_id, a.article_label, a.article_no, a.branch,
                   a.chapter, a.section, a.content, a.order_index,
                   d.title, d.category
            FROM articles a JOIN documents d ON d.id = a.document_id
            WHERE a.document_id IN ({placeholders}) AND a.article_no = ?
            ORDER BY a.document_id, a.order_index LIMIT ?""",
        (*doc_ids, q.article_no, limit),
    ).fetchall()
    return [
        {
            "kind": "article",
            "id": r["id"],
            "document_id": r["document_id"],
            "doc_type": "statute",
            "title": r["title"],
            "category": r["category"],
            "label": r["article_label"],
            "branch": r["branch"],
            "chapter": r["chapter"],
            "section": r["section"],
            "content": r["content"],
        }
        for r in rows
    ]


def _query_tokens(q: str):
    tokens, seen = [], set()
    for t in jieba.cut((q or "").strip()):
        t = t.strip()
        if t and len(t) >= 2 and t not in seen and _TOKEN_RE.match(t):
            seen.add(t)
            tokens.append(t)
    if not tokens:  # 全是单字时降级为单字匹配
        for t in jieba.cut((q or "").strip()):
            t = t.strip()
            if t and t not in seen and _TOKEN_RE.match(t):
                seen.add(t)
                tokens.append(t)
    return tokens


def highlight(text, tokens):
    text = html.escape(text)
    toks = sorted({re.escape(t) for t in tokens if t}, key=len, reverse=True)
    if not toks:
        return text
    return re.sub("|".join(toks), lambda m: f"<em>{m.group(0)}</em>", text)


def make_snippet(content, tokens, width=80):
    if not content:
        return ""
    hit = -1
    for t in sorted(tokens, key=len, reverse=True):
        hit = content.find(t)
        if hit >= 0:
            break
    if hit < 0:
        snippet = content[:width]
        return highlight(snippet, tokens) + ("…" if len(content) > width else "")
    start = max(0, hit - 20)
    end = min(len(content), hit + width)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(content) else ""
    return prefix + highlight(content[start:end], tokens) + suffix


def search_fulltext(conn, q, doc_type=None, category=None, document_id=None, limit=50):
    """全文检索：FTS5 OR 匹配 + bm25 排序，Python 侧摘要高亮，返回 article 与 chunk 两类结果。"""
    tokens = _query_tokens(q)
    if not tokens:
        return []
    # OR 匹配 + bm25 排序：多关键词部分命中也召回（如"离婚 冷静期"——
    # 第1077条原文并不含"冷静期"，AND 会漏掉它），命中期越多排越前。
    match = " OR ".join(tokens)
    results = []

    sql = """SELECT a.id, a.document_id, a.article_label, a.content,
                    d.title, d.doc_type, d.category
             FROM articles_fts f
             JOIN articles a ON a.id = f.article_id
             JOIN documents d ON d.id = a.document_id
             WHERE articles_fts MATCH ? """
    params = [match]
    sql, params = _apply_filters(sql, params, doc_type, category, document_id, "a")
    sql += "ORDER BY rank LIMIT ?"
    params.append(limit)
    for r in conn.execute(sql, params):
        results.append(
            {
                "kind": "article",
                "id": r["id"],
                "document_id": r["document_id"],
                "doc_type": r["doc_type"],
                "title": r["title"],
                "category": r["category"],
                "label": r["article_label"],
                "snippet": make_snippet(r["content"], tokens),
            }
        )

    sql = """SELECT c.id, c.document_id, c.seq, c.content,
                    d.title, d.doc_type, d.category
             FROM chunks_fts f
             JOIN chunks c ON c.id = f.chunk_id
             JOIN documents d ON d.id = c.document_id
             WHERE chunks_fts MATCH ? """
    params = [match]
    sql, params = _apply_filters(sql, params, doc_type, category, document_id, "c")
    sql += "ORDER BY rank LIMIT ?"
    params.append(limit)
    for r in conn.execute(sql, params):
        results.append(
            {
                "kind": "chunk",
                "id": r["id"],
                "document_id": r["document_id"],
                "doc_type": r["doc_type"],
                "title": r["title"],
                "category": r["category"],
                "label": f"第{r['seq'] + 1}段",
                "snippet": make_snippet(r["content"], tokens),
            }
        )
    return results


def _apply_filters(sql, params, doc_type, category, document_id, table_alias):
    if doc_type:
        sql += "AND d.doc_type=? "
        params.append(doc_type)
    if category:
        sql += "AND d.category=? "
        params.append(category)
    if document_id:
        sql += f"AND {table_alias}.document_id=? "
        params.append(document_id)
    return sql, params
```

**规则要点**：
- **BM25**：Python 侧不自己实现，直接用 SQLite FTS5 内置 `rank`（即 bm25()，越小越相关），`ORDER BY rank`。
- **匹配策略**：查询词 jieba 切词（`^\w+$`、长度≥2、去重），空了降级单字；FTS5 MATCH 用 ` OR ` 连接（全文检索处不加引号），部分命中也召回。
- **高亮**：先 `html.escape` 全文，再按 token 长度降序拼正则替换为 `<em>…</em>`。
- **摘要**：找最长 token 的首次位置，窗口 `[hit-20, hit+80]`，前后加 `…`；无命中取前 80 字符。
- chunk 结果 label 为 `第{seq+1}段`。

**法条定位解析**（有单元测试佐证，tests/unit/test_query_parse.py）：
1. 优先匹配 `第\s*([中文数字或\d]+)\s*条`（search 任意位置，允许空格），条号走 cn2num，hint = 去掉该片段后的剩余文本。例：`民法典第一千零七十七条`→hint=民法典/no=1077；`公司法 第51条`→hint=公司法/51。
2. 否则匹配**尾部 1~5 位阿拉伯数字**，hint = 去尾后的前缀。例：`民法典 1077`、`民法典1077`、`1077`（hint=""）。
3. 都没有 → None（走全文检索）。`离婚 冷静期`、`民法典`、`劳动法加班费` 均不能定位。
4. `match_documents`：只对 `doc_type='statute'` 的文档匹配；**hint 为空 = 全部法规**；先子串（原题名或去掉“中华人民共和国”的规范化题名），再子序列（hint 每个字符按序出现在题名中，用 `iter` 惰性消费实现）；exact 排前、fuzzy 排后，组内按 id。
5. `search_locate`：按 `document_id IN (...) AND article_no=?` 精确取条，`ORDER BY document_id, order_index LIMIT 20`；hint 匹配不到任何法规时退化为全部法规找同号条。

**法规简称表**：**不存在显式简称/别名表**。“民诉法→民事诉讼法”这类简写完全靠 `match_documents` 的两级启发式：子串（含去“中华人民共和国”归一化）+ 字符子序列。完整度评估：对“简写是全名（去国名前缀）字符子序列”的简称有效（民诉法/刑诉法/劳动法等）；对**插字型简称（如“民法典婚姻家庭编解释”对长全名）、音序字序不同的简称（如“民诉解释”这类乱序缩写）不保证命中**，且子序列误召回可能（短 hint 易撞多个法规）。移植时如需更强能力，应补一张显式 alias 表。

### retriever.py（RAG 上下文组装）

- `_CONTEXT_BUDGET = 1800` 字符预算。
- `neighbors_context(article_row, count=2)`：同文档 `order_index BETWEEN o-2 AND o+2` 且排除自身，取前后各 2 条相邻条文。
- `related_statutes_context(limit=3)`：取本条 content 的 `_query_tokens` 前 8 个，FTS 查 `'"tok1" OR "tok2"…'`（**这里 token 加了双引号**），排除同文档，按 rank 取 3 条其它法规条文。
- `related_cases_context(limit=3)`：chunks_fts 查 `doc_type='case'` 段落，label 统一“相关段落”。
- `cases_context`：案例无命中时退化检索 `doc_type<>'statute'` 的全部段落（limit 3）。
- `render_context(items, budget=1800)`：逐项渲染 `《title》label\ncontent`，剩余空间 ≤60 停止，单条 clip 到剩余空间（超长加 `…`），`\n\n` join。
- `explain_context` = 本条 + 相邻条文 + 相关法规条文 一起 render。

---

## 5. AI 部分

### ai_provider.py

- **OpenAI 兼容协议**客户端：POST `{base_url}/chat/completions`，body `{model, messages, temperature: 0.3, stream: False}`，头 `Authorization: Bearer <key>`，timeout 90s。**没有流式**——所有 AI 请求 `stream: False`、一次性返回完整 JSON，端点同步等待后整包返回；前端无 SSE/WebSocket。
- 错误体系：`AINotConfigured`（未配置）、`AICallError`（网络失败→`"网络请求失败：{type}"`；401→`"接口认证失败（401）：请检查 API Key 是否正确"`；非 200→`"接口返回 {code}：{text[:200]}"`；响应缺 `choices[0].message.content`→`"接口响应格式异常…"`）。
- 配置读取：settings 表 `ai_base_url / ai_api_key / ai_model`；三者**全部非空**才算已配置。注释声明兼容 DeepSeek/通义/Kimi/OpenAI。

### routers/ai.py

**系统提示词（原文，三个操作共用）**：
```
你是一位严谨的中国法律研究助手。回答使用简体中文与 Markdown 格式。引用法条时必须写成《法规全名》第X条 的格式，且只能引用用户提供的材料中确实存在的条文，严禁编造法条号或法规名。材料中没有的内容要明确说明。
```

**三操作 user 提示词（原文拼接格式）**：
- explain：`"请解释下面这条法条：分「条文主旨」「适用场景」「实务要点」三部分，语言平实、面向非法律专业人士。\n\n【材料】\n" + explain_context(...)`（材料含本条/相邻/相关条文）
- cases 有材料：`"请基于下面这条法条，结合【材料】中用户本地文档库的内容，归纳相关案例或适用情形；材料中没有案例时要如实说明，不要虚构。\n\n【目标法条】\n《{title}》{label}\n{content}\n\n【材料】\n{context}"`
- cases 无材料：`"请围绕下面这条法条，说明该条通常涉及哪些典型纠纷类型与适用情形，并提示：用户本地文档库中暂未检索到相关案例材料。\n\n《{title}》{label}\n{content}"`
- followup：`messages = [system] + 历史 + user`，user 内容 = （若带 article_id）`"【当前条文】\n《{title}》{label}\n{content}\n\n"` + 问题本身。**历史**：取该 article/topic 最近 6 条（id DESC 再 reverse），explain/cases 的 question 为空时分别代填“请解释这条法条”/“请找相关案例”；user 截 400 字、assistant 截 800 字。

**引用解析规则**（`resolve_citations`）：
- 正则：`《([^《》]{1,60})》\s*第\s*([零〇一二三四五六七八九十百千\d]+)\s*条`（法规名 1-60 字，禁套书名号）
- 条号支持中文/阿拉伯数字（cn2num）；按 (name, no) 去重；解析失败跳过
- 归库：`match_documents(name)` → 在命中文档里查 `article_no` 相等的第一条（ORDER BY order_index LIMIT 1）；命中 → `{article_id, title, label, cite_text}`；未命中 → `{article_id: None, title: name, label: "第{no}条", cite_text}`（不可点击）
- 存入 ai_messages.citations 为 JSON 数组

**问答归档表**：ai_messages（见 §1），action ∈ `explain | cases | followup`；explain/cases 存 question=""，followup 存原问题。

**设置接口**：GET 返回 `{base_url, model, api_key_set, api_key_masked}`；掩码规则 `key[:3] + "*"*max(4, len-6) + key[-3:]`。PUT body `{base_url, model, api_key?}`——api_key 为 None/空串表示**保持不变**，非空才更新（upsert 语义）。POST /ai/test 用固定消息“请回复：连接正常”试连通，返回 `{ok, reply[:50]}`。

---

## 6. 工作台（workspace.py + exporter.py）

**API 语义**：
- 专题 CRUD：列表带 `item_count/note_count` 子查询计数，`ORDER BY updated_at DESC, id DESC`；创建/改名重名返回 **409**、空名 **422**；任何条目/笔记变动都 `_touch` 刷新 topics.updated_at。
- 收藏：`POST /topics/{id}/items {article_id}`——法条不存在 404；重复收藏返回 `{status:"duplicate", item_id}`（幂等，201/200 均 200）；order_index = `MAX(order_index)+1`（空则 0）；删除按 (topic_id, article_id) 定位。
- 笔记：必须挂 topic；article_id 可空（存在性校验）；content_md 空则 422；更新只改 content_md + updated_at；topic 删除级联删笔记；article 删除时笔记保留（SET NULL）。
- 专题详情：items 按 order_index 排，带法条全文 + 文档 title/category/doc_type；notes 按 `updated_at DESC, id DESC` 排，LEFT JOIN 出 article_label。

**导出（exporter.py）**：
- 数据装载 `_load`：items 按 order_index、notes 按 `created_at, id`。
- `_split_notes`：有 article_id 的笔记按法条分组，其余为专题级笔记。
- `_location`：`branch › chapter › section`（用 " › " 连接非空层级）。
- **Markdown 结构**：`# 专题名` → `> description` → 逐条 `## {序号}. {label}（{文档名}）` + `**层级**：{loc}` + 条文原文 + 该条笔记（每行 `> ` 前缀、`> **笔记**（时间）` 开头）→ 末尾 `## 专题笔记` 区块 → 落款 `---` + `*导出自 LexBench · 法研台 · 共 X 条法条 / Y 则笔记*`。
- **docx**：python-docx，Normal 样式 Times New Roman 12pt；专题名 Heading 0、描述斜体；每条 Heading 2 + 层级段（9pt）+ 按行成段 + 笔记斜体（`【笔记】` 前缀）；专题笔记区 Heading 2。BytesIO 返回 bytes。
- HTTP 层：`GET /topics/{id}/export?format=md|docx`；文件名经 `urllib.parse.quote` 走 `filename*=UTF-8''` RFC5987；docx MIME 全称 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`，md 为 `text/markdown; charset=utf-8`。

---

## 7. 全部 HTTP API 端点清单（均挂 `/api` 前缀）

### documents（routers/documents.py）
| 方法 | 路径 | 参数 | 返回 |
|---|---|---|---|
| POST | /api/documents | multipart：`files`（多文件，必填）、`category` Form 默认 "" | `{results: [{status, title, document_id, doc_type, article_count, message}]}` |
| GET | /api/documents | query：`doc_type` / `category` / `status`（均可选） | 文档数组（documents 全列），ORDER BY id DESC |
| GET | /api/documents/{document_id} | — | 文档全字段 + `articles[]`（不含 id 外全列，按 order_index） + `chunks[]`（按 seq）；404 “文档不存在” |
| PUT | /api/documents/{document_id}/status | body `{status}`（仅 parsed/needs_review，否则 422） | `{ok:true}`；404 文档不存在 |
| DELETE | /api/documents/{document_id} | — | `{ok:true}`（先 remove_document_content 再删行） |

### search（routers/search.py）
| 方法 | 路径 | 参数 | 返回 |
|---|---|---|---|
| GET | /api/search | query：`q`（必填）、`mode` 默认 auto（locate/fulltext/auto）、`doc_type` / `category` / `document_id` 可选 | `{mode, query, results[]}`；q 空→mode "none"；auto 时 parse_locate_query 命中→locate，locate 零结果自动降级 fulltext（响应 mode 同步变化）。locate 结果含法条全字段（kind=article），fulltext 结果含 snippet（kind=article/chunk） |
| GET | /api/articles/{article_id} | — | 法条 + 文档 title/category + `prev`/`next`（同文档 order_index 相邻条的 `{id,label}`）；404 |
| PUT | /api/articles/{article_id} | body `{content}`（strip 后空→422） | `{ok:true}`；更新内容并 reindex_article；404 |

### workspace（routers/workspace.py）
| 方法 | 路径 | 参数 | 返回 |
|---|---|---|---|
| GET | /api/topics | — | `[{id,name,description,updated_at,item_count,note_count}]` |
| POST | /api/topics | body `{name, description?}` | 201 `{id,name,description,item_count:0,note_count:0}`；422 空名；409 重名 |
| GET | /api/topics/{topic_id} | — | `{id,name,description,items[],notes[]}`；404 |
| PUT | /api/topics/{topic_id} | body `{name?, description?}`（None 跳过） | `{ok:true}`；422/409 同上 |
| DELETE | /api/topics/{topic_id} | — | `{ok:true}` |
| POST | /api/topics/{topic_id}/items | body `{article_id}` | `{status:"added"\|"duplicate", item_id}`；404 专题/法条不存在 |
| DELETE | /api/topics/{topic_id}/items/{article_id} | — | `{ok:true}`；404 “该法条不在此专题中” |
| POST | /api/notes | body `{topic_id, article_id?, content_md}` | 201 笔记全字段 dict；404；422 空内容 |
| PUT | /api/notes/{note_id} | body `{content_md}` | `{ok:true}`；404；422 |
| DELETE | /api/notes/{note_id} | — | `{ok:true}`；404 |
| GET | /api/topics/{topic_id}/export | query `format` 默认 "md"，"docx" 时出 Word | 文件下载（Content-Disposition attachment，UTF-8 文件名） |

### ai（routers/ai.py）
| 方法 | 路径 | 参数 | 返回 |
|---|---|---|---|
| GET | /api/ai/settings | — | `{base_url, model, api_key_set, api_key_masked}` |
| PUT | /api/ai/settings | body `{base_url, model, api_key?}`（api_key None/空=不改） | `{ok:true}` |
| POST | /api/ai/test | — | `{ok, reply[:50]}`；400 未配置；502 调用失败 |
| POST | /api/ai/explain | body `{article_id}` | 消息 dict `{id,article_id,topic_id,action,question,answer_md,citations[],created_at}`；404 法条不存在；400/502 同上 |
| POST | /api/ai/cases | body `{article_id}` | 同上（action=cases） |
| POST | /api/ai/followup | body `{article_id? , topic_id?, question}`（二者至少一个否则 422） | 同上（action=followup，question 存原文） |
| GET | /api/ai/history | query `article_id` 或 `topic_id`（都没有 422） | 消息 dict 数组，按 id 升序 |
| DELETE | /api/ai/messages/{message_id} | — | `{ok:true}`；404 |

另有 `/` 挂载前端静态目录（`StaticFiles(html=True)`，目录存在时）。

---

## 8. 应用装配（main.py + desktop.py + config.py）

### main.py 装配

```python
def create_app(db_path=None, files_dir=None):
    app = FastAPI(title="LexBench · 法研台")
    db_path = Path(db_path) if db_path else config.DB_PATH
    files_dir = Path(files_dir) if files_dir else config.FILES_DIR

    init_db(db_path)
    app.state.conn = connect(db_path)      # 单连接挂在 app.state
    app.state.db_path = db_path
    app.state.files_dir = files_dir

    app.include_router(documents.router, prefix="/api")
    app.include_router(search.router, prefix="/api")
    app.include_router(workspace.router, prefix="/api")
    app.include_router(ai.router, prefix="/api")

    if config.FRONTEND_DIST.exists():
        app.mount("/", StaticFiles(directory=config.FRONTEND_DIST, html=True), name="frontend")
    return app

app = create_app()   # 模块级实例：源码 Web 模式 uvicorn app.main:app 直接用
```

### config.py

- `FROZEN`（PyInstaller `sys.frozen`）决定路径：frozen 时 APP_DIR=exe 目录（便携式，数据存旁边）、BUNDLE_DIR=`sys._MEIPASS`（frontend_dist/VERSION 在此）；源码模式 REPO_ROOT=上三级目录，前端在 `frontend/dist`。
- `DATA_DIR = $LEXBENCH_DATA_DIR 或 APP_DIR/data`；`DB_PATH = DATA_DIR/lexbench.db`；`FILES_DIR = DATA_DIR/files`。
- `HOST = $LEXBENCH_HOST 或 127.0.0.1`；**`PORT = $LEXBENCH_PORT 或 8788`**。
- VERSION 读 VERSION 文件，缺省 "0.0.0"。

### desktop.py（桌面窗口模式）

- **单实例**：Windows 命名互斥体 `LexBenchSingleInstance`（CreateMutexW + ERROR_ALREADY_EXISTS 183）。
- **防压缩包内运行**：检测 APP_DIR 是否位于 Temp 下 zip 工具特征目录（前缀 `Rar$、Temp1_、Temp2_、7zO、7zS、BANDIZIPTEMP`）。
- **端口**：`pick_port` 从 8788 起连续探测 20 个，全占用弹窗退出。
- **服务**：daemon 线程跑 `uvicorn.Server(Config(app, host, port, log_config=None, access_log=False, log_level="warning"))`；健康检查 `GET /api/documents` 须 20 秒内 200，超时退出。
- **窗口**：pywebview `create_window("LexBench · 法研台 v{VERSION}", url, width=1440, height=920, min_size=(1024,640))`；webview 导入失败/创建失败提示装 WebView2（官方下载链接硬编码）。
- **诊断**：desktop.log（exe 旁，UTF-8 append）；`attach_error_logging` 给 FastAPI 兜底异常处理器（写日志、返 500 `{"detail":"internal server error"}`）。窗口关闭后 `server.should_exit=True` 并关连接。

### 移植总注意事项

1. 单 SQLite 连接 + `check_same_thread=False` + Row factory；TS/IPC 侧需决定连接策略（建议 better-sqlite3 同步单连接，语义最接近）。
2. FTS 内容是 jieba 切词文本——TS 侧要么换分词器并重建索引（旧库迁移需重索引），要么照搬 jieba 词表；`user_version` 迁移机制可沿用。
3. 所有时间戳为 `datetime('now','localtime')` 本地时间字符串，非 UTC。
4. 导出/设置的中文文件名走 RFC 5987；AI 无流式；bm25 依赖 FTS5 `rank`。
5. “needs_review” 判定阈值 `_MIN_AVG_ARTICLE_LEN = 20`、分块 `target=500`、上下文预算 `1800`、定位 limit=20、检索 limit=50、AI 历史 6 条/400/800 截断——这些魔法数均为行为的一部分。