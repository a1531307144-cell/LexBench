import shutil
import uuid
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from app.services.importer import import_file
from app.services.indexer import remove_document_content

router = APIRouter(tags=["documents"])


@router.post("/documents")
async def upload_documents(
    request: Request,
    files: list[UploadFile] = File(...),
    category: str = Form(""),
):
    conn = request.app.state.conn
    files_dir = request.app.state.files_dir
    tmp_dir = files_dir / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for f in files:
        suffix = Path(f.filename or "").suffix
        tmp = tmp_dir / f"{uuid.uuid4().hex}{suffix}"
        try:
            with open(tmp, "wb") as out:
                shutil.copyfileobj(f.file, out)
            results.append(
                asdict(import_file(conn, tmp, files_dir, category, original_name=f.filename))
            )
        finally:
            tmp.unlink(missing_ok=True)
    return {"results": results}


@router.get("/documents")
def list_documents(
    request: Request,
    doc_type: str = None,
    category: str = None,
    status: str = None,
):
    conn = request.app.state.conn
    sql = "SELECT * FROM documents WHERE 1=1"
    params = []
    if doc_type:
        sql += " AND doc_type=?"
        params.append(doc_type)
    if category:
        sql += " AND category=?"
        params.append(category)
    if status:
        sql += " AND status=?"
        params.append(status)
    sql += " ORDER BY id DESC"
    return [dict(r) for r in conn.execute(sql, params)]


@router.get("/documents/{document_id}")
def document_detail(document_id: int, request: Request):
    conn = request.app.state.conn
    doc = conn.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
    if doc is None:
        raise HTTPException(404, "文档不存在")
    articles = [
        dict(r)
        for r in conn.execute(
            "SELECT id, article_label, article_no, branch, chapter, section, content,"
            " order_index FROM articles WHERE document_id=? ORDER BY order_index",
            (document_id,),
        )
    ]
    chunks = [
        dict(r)
        for r in conn.execute(
            "SELECT id, seq, content FROM chunks WHERE document_id=? ORDER BY seq",
            (document_id,),
        )
    ]
    body = dict(doc)
    body["articles"] = articles
    body["chunks"] = chunks
    return body


@router.delete("/documents/{document_id}")
def delete_document(document_id: int, request: Request):
    conn = request.app.state.conn
    doc = conn.execute("SELECT id FROM documents WHERE id=?", (document_id,)).fetchone()
    if doc is None:
        raise HTTPException(404, "文档不存在")
    remove_document_content(conn, document_id)
    conn.execute("DELETE FROM documents WHERE id=?", (document_id,))
    conn.commit()
    return {"ok": True}
