from fastapi import APIRouter, HTTPException, Request

from app.services.search import parse_locate_query, search_fulltext, search_locate

router = APIRouter(tags=["search"])


@router.get("/search")
def search(
    request: Request,
    q: str,
    mode: str = "auto",
    doc_type: str = None,
    category: str = None,
    document_id: int = None,
):
    conn = request.app.state.conn
    q = (q or "").strip()
    if not q:
        return {"mode": "none", "query": q, "results": []}
    if mode == "auto":
        mode = "locate" if parse_locate_query(q) else "fulltext"
    results = []
    if mode == "locate":
        results = search_locate(conn, q)
        if not results:  # 定位无结果 → 降级全文
            mode = "fulltext"
    if mode == "fulltext":
        results = search_fulltext(
            conn, q, doc_type=doc_type, category=category, document_id=document_id
        )
    return {"mode": mode, "query": q, "results": results}


@router.get("/articles/{article_id}")
def article_detail(article_id: int, request: Request):
    conn = request.app.state.conn
    r = conn.execute(
        "SELECT a.*, d.title, d.category FROM articles a"
        " JOIN documents d ON d.id = a.document_id WHERE a.id=?",
        (article_id,),
    ).fetchone()
    if r is None:
        raise HTTPException(404, "法条不存在")
    prev = conn.execute(
        "SELECT id, article_label AS label FROM articles"
        " WHERE document_id=? AND order_index < ? ORDER BY order_index DESC LIMIT 1",
        (r["document_id"], r["order_index"]),
    ).fetchone()
    next_ = conn.execute(
        "SELECT id, article_label AS label FROM articles"
        " WHERE document_id=? AND order_index > ? ORDER BY order_index ASC LIMIT 1",
        (r["document_id"], r["order_index"]),
    ).fetchone()
    return {
        "id": r["id"],
        "document_id": r["document_id"],
        "title": r["title"],
        "category": r["category"],
        "label": r["article_label"],
        "article_no": r["article_no"],
        "branch": r["branch"],
        "chapter": r["chapter"],
        "section": r["section"],
        "content": r["content"],
        "prev": dict(prev) if prev else None,
        "next": dict(next_) if next_ else None,
    }
