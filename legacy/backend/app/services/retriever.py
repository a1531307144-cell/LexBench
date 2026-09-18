"""Retriever：为 AI 组装本地检索上下文（RAG）。

原则：只把用户本地文档库里的内容喂给 AI；上下文有长度预算，超预算截断。
"""
from app.services.indexer import tokenize
from app.services.search import _query_tokens

_CONTEXT_BUDGET = 1800  # 字符预算：控制提示词规模与调用成本


def _fetch_article(conn, article_id):
    return conn.execute(
        "SELECT a.id, a.document_id, a.article_label, a.article_no, a.content,"
        " a.order_index, d.title, d.category"
        " FROM articles a JOIN documents d ON d.id=a.document_id WHERE a.id=?",
        (article_id,),
    ).fetchone()


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def neighbors_context(conn, article_row, count=2) -> list[dict]:
    """相邻条文（前 count 条 + 后 count 条）：法条解释最直接的参照。"""
    rows = conn.execute(
        "SELECT a.id, a.article_label, a.content, d.title"
        " FROM articles a JOIN documents d ON d.id=a.document_id"
        " WHERE a.document_id=? AND a.order_index BETWEEN ? AND ?"
        " AND a.id<>? ORDER BY a.order_index",
        (
            article_row["document_id"],
            article_row["order_index"] - count,
            article_row["order_index"] + count,
            article_row["id"],
        ),
    ).fetchall()
    return [
        {"title": r["title"], "label": r["article_label"], "content": r["content"]}
        for r in rows
    ]


def related_statutes_context(conn, article_row, limit=3) -> list[dict]:
    """FTS 检索其他法规中的相关条文（排除同一文档）。"""
    tokens = _query_tokens(article_row["content"])[:8]
    if not tokens:
        return []
    match = " OR ".join(f'"{t}"' for t in tokens)
    rows = conn.execute(
        'SELECT a.id, a.article_label, a.content, d.title FROM articles_fts f'
        " JOIN articles a ON a.id=f.article_id"
        " JOIN documents d ON d.id=a.document_id"
        " WHERE articles_fts MATCH ? AND a.document_id<>?"
        " ORDER BY rank LIMIT ?",
        (match, article_row["document_id"], limit),
    ).fetchall()
    return [
        {"title": r["title"], "label": r["article_label"], "content": r["content"]}
        for r in rows
    ]


def related_cases_context(conn, article_row, limit=3) -> list[dict]:
    """FTS 检索本地案例类文档的相关段落。"""
    tokens = _query_tokens(article_row["content"])[:8]
    if not tokens:
        return []
    match = " OR ".join(f'"{t}"' for t in tokens)
    rows = conn.execute(
        'SELECT c.content, d.title FROM chunks_fts f'
        " JOIN chunks c ON c.id=f.chunk_id"
        " JOIN documents d ON d.id=c.document_id"
        " WHERE chunks_fts MATCH ? AND d.doc_type='case'"
        " ORDER BY rank LIMIT ?",
        (match, limit),
    ).fetchall()
    return [{"title": r["title"], "label": "相关段落", "content": r["content"]} for r in rows]


def render_context(items: list[dict], budget: int = _CONTEXT_BUDGET) -> str:
    """把 [{title,label,content}] 渲染为【材料】文本块，总量不超过预算。"""
    parts, used = [], 0
    for it in items:
        room = budget - used
        if room <= 60:
            break
        body = f"《{it['title']}》{it['label']}\n{_clip(it['content'], room)}"
        used += len(body)
        parts.append(body)
    return "\n\n".join(parts)


def explain_context(conn, article_row) -> str:
    return render_context(
        [
            {
                "title": article_row["title"],
                "label": article_row["article_label"],
                "content": article_row["content"],
            }
        ]
        + neighbors_context(conn, article_row)
        + related_statutes_context(conn, article_row)
    )


def cases_context(conn, article_row) -> str:
    cases = related_cases_context(conn, article_row)
    if cases:
        return render_context(cases)
    # 本地无案例类文档命中时，退化为检索全部文档（用户库可能未标注类型）
    tokens = _query_tokens(article_row["content"])[:8]
    if not tokens:
        return ""
    match = " OR ".join(f'"{t}"' for t in tokens)
    rows = conn.execute(
        'SELECT c.content, d.title, d.doc_type FROM chunks_fts f'
        " JOIN chunks c ON c.id=f.chunk_id"
        " JOIN documents d ON d.id=c.document_id"
        " WHERE chunks_fts MATCH ? AND d.doc_type<>'statute'"
        " ORDER BY rank LIMIT 3",
        (match,),
    ).fetchall()
    return render_context(
        [{"title": r["title"], "label": "相关段落", "content": r["content"]} for r in rows]
    )


def get_article_or_404(conn, article_id):
    row = _fetch_article(conn, article_id)
    return row
