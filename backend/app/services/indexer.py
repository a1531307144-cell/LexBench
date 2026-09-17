import re

import jieba

jieba.setLogLevel(60)  # 关闭"Building prefix dict"日志

_TOKEN_RE = re.compile(r"^\w+$", re.UNICODE)


def tokenize(text: str) -> str:
    """jieba 切词，空格分隔（FTS5 索引/查询共用同一分词规则）。"""
    return " ".join(t for t in jieba.cut(text) if t.strip() and _TOKEN_RE.match(t))


def index_articles(conn, document_id, articles) -> None:
    for a in articles:
        cur = conn.execute(
            "INSERT INTO articles(document_id, article_label, article_no, branch,"
            " chapter, section, content, order_index) VALUES(?,?,?,?,?,?,?,?)",
            (document_id, a.label, a.no, a.branch, a.chapter, a.section, a.content, a.order_index),
        )
        conn.execute(
            "INSERT INTO articles_fts(article_id, content) VALUES(?,?)",
            (cur.lastrowid, tokenize(a.content)),
        )
    conn.execute(
        "UPDATE documents SET article_count=? WHERE id=?", (len(articles), document_id)
    )
    conn.commit()


def index_chunks(conn, document_id, chunks) -> None:
    for i, text in enumerate(chunks):
        cur = conn.execute(
            "INSERT INTO chunks(document_id, seq, content) VALUES(?,?,?)",
            (document_id, i, text),
        )
        conn.execute(
            "INSERT INTO chunks_fts(chunk_id, content) VALUES(?,?)",
            (cur.lastrowid, tokenize(text)),
        )
    conn.commit()


def reindex_article(conn, article_id) -> None:
    """单条法条内容修正后重建其 FTS 索引行。"""
    row = conn.execute(
        "SELECT content FROM articles WHERE id=?", (article_id,)
    ).fetchone()
    if row is None:
        return
    conn.execute("DELETE FROM articles_fts WHERE article_id=?", (article_id,))
    conn.execute(
        "INSERT INTO articles_fts(article_id, content) VALUES(?,?)",
        (article_id, tokenize(row["content"])),
    )
    conn.commit()


def remove_document_content(conn, document_id) -> None:
    """删除文档的法条/段落行及其 FTS 索引行（FTS 表不随外键级联）。"""
    conn.execute(
        "DELETE FROM articles_fts WHERE article_id IN"
        " (SELECT id FROM articles WHERE document_id=?)",
        (document_id,),
    )
    conn.execute(
        "DELETE FROM chunks_fts WHERE chunk_id IN"
        " (SELECT id FROM chunks WHERE document_id=?)",
        (document_id,),
    )
    conn.execute("DELETE FROM articles WHERE document_id=?", (document_id,))
    conn.execute("DELETE FROM chunks WHERE document_id=?", (document_id,))
    conn.commit()
