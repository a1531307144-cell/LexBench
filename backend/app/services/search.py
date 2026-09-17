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
