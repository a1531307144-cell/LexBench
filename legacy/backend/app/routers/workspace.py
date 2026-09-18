from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from app.services.exporter import export_docx, export_markdown

router = APIRouter(tags=["workspace"])

DOCX_MIME = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


class TopicIn(BaseModel):
    name: str
    description: str = ""


class TopicUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class ItemIn(BaseModel):
    article_id: int


class NoteIn(BaseModel):
    topic_id: int
    article_id: int | None = None
    content_md: str


class NoteUpdate(BaseModel):
    content_md: str


def _touch(conn, topic_id):
    conn.execute(
        "UPDATE topics SET updated_at=datetime('now','localtime') WHERE id=?",
        (topic_id,),
    )


def _get_topic(conn, topic_id):
    row = conn.execute("SELECT * FROM topics WHERE id=?", (topic_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "专题不存在")
    return row


def _note_dict(row):
    d = dict(row)
    d.pop("article_label", None)
    return d


@router.get("/topics")
def list_topics(request: Request):
    conn = request.app.state.conn
    rows = conn.execute(
        "SELECT t.id, t.name, t.description, t.updated_at,"
        " (SELECT COUNT(*) FROM topic_items i WHERE i.topic_id=t.id) AS item_count,"
        " (SELECT COUNT(*) FROM notes n WHERE n.topic_id=t.id) AS note_count"
        " FROM topics t ORDER BY t.updated_at DESC, t.id DESC"
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("/topics", status_code=201)
def create_topic(body: TopicIn, request: Request):
    conn = request.app.state.conn
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "专题名不能为空")
    if conn.execute("SELECT 1 FROM topics WHERE name=?", (name,)).fetchone():
        raise HTTPException(409, f"已存在同名专题：{name}")
    cur = conn.execute(
        "INSERT INTO topics(name, description) VALUES(?,?)",
        (name, body.description.strip()),
    )
    conn.commit()
    return {
        "id": cur.lastrowid,
        "name": name,
        "description": body.description.strip(),
        "item_count": 0,
        "note_count": 0,
    }


@router.get("/topics/{topic_id}")
def topic_detail(topic_id: int, request: Request):
    conn = request.app.state.conn
    topic = _get_topic(conn, topic_id)
    items = conn.execute(
        "SELECT i.id AS item_id, i.article_id, i.order_index, a.article_label AS label,"
        " a.article_no, a.branch, a.chapter, a.section, a.content,"
        " d.title, d.category, d.doc_type"
        " FROM topic_items i JOIN articles a ON a.id=i.article_id"
        " JOIN documents d ON d.id=a.document_id"
        " WHERE i.topic_id=? ORDER BY i.order_index",
        (topic_id,),
    ).fetchall()
    notes = conn.execute(
        "SELECT n.id, n.topic_id, n.article_id, n.content_md, n.created_at, n.updated_at,"
        " a.article_label FROM notes n LEFT JOIN articles a ON a.id=n.article_id"
        " WHERE n.topic_id=? ORDER BY n.updated_at DESC, n.id DESC",
        (topic_id,),
    ).fetchall()
    return {
        "id": topic["id"],
        "name": topic["name"],
        "description": topic["description"],
        "items": [dict(r) for r in items],
        "notes": [_note_dict(r) for r in notes],
    }


@router.put("/topics/{topic_id}")
def update_topic(topic_id: int, body: TopicUpdate, request: Request):
    conn = request.app.state.conn
    _get_topic(conn, topic_id)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(422, "专题名不能为空")
        dup = conn.execute(
            "SELECT 1 FROM topics WHERE name=? AND id<>?", (name, topic_id)
        ).fetchone()
        if dup:
            raise HTTPException(409, f"已存在同名专题：{name}")
        conn.execute("UPDATE topics SET name=? WHERE id=?", (name, topic_id))
    if body.description is not None:
        conn.execute(
            "UPDATE topics SET description=? WHERE id=?",
            (body.description.strip(), topic_id),
        )
    _touch(conn, topic_id)
    conn.commit()
    return {"ok": True}


@router.delete("/topics/{topic_id}")
def delete_topic(topic_id: int, request: Request):
    conn = request.app.state.conn
    _get_topic(conn, topic_id)
    conn.execute("DELETE FROM topics WHERE id=?", (topic_id,))
    conn.commit()
    return {"ok": True}


@router.post("/topics/{topic_id}/items")
def add_item(topic_id: int, body: ItemIn, request: Request):
    conn = request.app.state.conn
    _get_topic(conn, topic_id)
    if not conn.execute(
        "SELECT 1 FROM articles WHERE id=?", (body.article_id,)
    ).fetchone():
        raise HTTPException(404, "法条不存在")
    existing = conn.execute(
        "SELECT id FROM topic_items WHERE topic_id=? AND article_id=?",
        (topic_id, body.article_id),
    ).fetchone()
    if existing:
        return {"status": "duplicate", "item_id": existing["id"]}
    next_order = conn.execute(
        "SELECT COALESCE(MAX(order_index), -1) + 1 FROM topic_items WHERE topic_id=?",
        (topic_id,),
    ).fetchone()[0]
    cur = conn.execute(
        "INSERT INTO topic_items(topic_id, article_id, order_index) VALUES(?,?,?)",
        (topic_id, body.article_id, next_order),
    )
    _touch(conn, topic_id)
    conn.commit()
    return {"status": "added", "item_id": cur.lastrowid}


@router.delete("/topics/{topic_id}/items/{article_id}")
def remove_item(topic_id: int, article_id: int, request: Request):
    conn = request.app.state.conn
    _get_topic(conn, topic_id)
    cur = conn.execute(
        "DELETE FROM topic_items WHERE topic_id=? AND article_id=?",
        (topic_id, article_id),
    )
    if cur.rowcount == 0:
        raise HTTPException(404, "该法条不在此专题中")
    _touch(conn, topic_id)
    conn.commit()
    return {"ok": True}


@router.post("/notes", status_code=201)
def create_note(body: NoteIn, request: Request):
    conn = request.app.state.conn
    _get_topic(conn, body.topic_id)
    if body.article_id is not None and not conn.execute(
        "SELECT 1 FROM articles WHERE id=?", (body.article_id,)
    ).fetchone():
        raise HTTPException(404, "法条不存在")
    content = body.content_md.strip()
    if not content:
        raise HTTPException(422, "笔记内容不能为空")
    cur = conn.execute(
        "INSERT INTO notes(topic_id, article_id, content_md) VALUES(?,?,?)",
        (body.topic_id, body.article_id, content),
    )
    _touch(conn, body.topic_id)
    conn.commit()
    row = conn.execute("SELECT * FROM notes WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


@router.put("/notes/{note_id}")
def update_note(note_id: int, body: NoteUpdate, request: Request):
    conn = request.app.state.conn
    row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "笔记不存在")
    content = body.content_md.strip()
    if not content:
        raise HTTPException(422, "笔记内容不能为空")
    conn.execute(
        "UPDATE notes SET content_md=?, updated_at=datetime('now','localtime')"
        " WHERE id=?",
        (content, note_id),
    )
    _touch(conn, row["topic_id"])
    conn.commit()
    return {"ok": True}


@router.delete("/notes/{note_id}")
def delete_note(note_id: int, request: Request):
    conn = request.app.state.conn
    row = conn.execute("SELECT topic_id FROM notes WHERE id=?", (note_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "笔记不存在")
    conn.execute("DELETE FROM notes WHERE id=?", (note_id,))
    _touch(conn, row["topic_id"])
    conn.commit()
    return {"ok": True}


@router.get("/topics/{topic_id}/export")
def export_topic(topic_id: int, format: str = "md", request: Request = None):
    conn = request.app.state.conn
    topic = _get_topic(conn, topic_id)
    filename = quote(topic["name"])
    if format == "docx":
        data = export_docx(conn, topic_id)
        return Response(
            content=data,
            media_type=DOCX_MIME,
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{filename}.docx"
            },
        )
    md = export_markdown(conn, topic_id)
    return Response(
        content=md,
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{filename}.md"
        },
    )
