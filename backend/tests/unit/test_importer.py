from pathlib import Path

import pytest
from docx import Document

from app.db.connection import connect, init_db
from app.services.importer import chunk_paragraphs, import_file


@pytest.fixture
def db(tmp_path):
    db_path = tmp_path / "t.db"
    init_db(db_path)
    conn = connect(db_path)
    yield conn, tmp_path / "files", tmp_path
    conn.close()


def _make_docx(tmp_path, paragraphs, name):
    doc = Document()
    for p in paragraphs:
        doc.add_paragraph(p)
    path = Path(tmp_path) / name
    doc.save(path)
    return path


STATUTE = [
    "中华人民共和国民法典（节选）",
    "第一编 总则",
    "第一章 基本规定",
    "第一条 为了保护民事主体的合法权益，调整民事关系，维护社会和经济秩序，制定本法。",
    "第二条 民法调整平等主体的自然人、法人和非法人组织之间的人身关系和财产关系。",
    "第三条 民事主体的人身权利、财产权利以及其他合法权益受法律保护，任何组织或者个人不得侵犯。",
    "第四条 民事主体在民事活动中的法律地位一律平等。",
    "第五条 民事主体从事民事活动，应当遵循自愿原则，按照自己的意思设立、变更、终止民事法律关系。",
    "第一千零七十七条 自婚姻登记机关收到离婚登记申请之日起三十日内，任何一方不愿意离婚的，可以向婚姻登记机关撤回离婚登记申请。",
]

CASE = [
    "北京市海淀区人民法院民事判决书",
    "（2023）京0108民初12345号",
    "本院认为，离婚冷静期制度旨在减少冲动离婚。",
]


def test_import_docx_statute(db):
    conn, files_dir, tmp_path = db
    path = _make_docx(tmp_path, STATUTE, "中华人民共和国民法典_20200528.docx")
    result = import_file(conn, path, files_dir)
    assert result.status == "imported"
    assert result.doc_type == "statute"
    assert result.article_count == 6
    assert result.title == "中华人民共和国民法典"  # 文件名去掉日期后缀
    row = conn.execute("SELECT * FROM documents WHERE id=?", (result.document_id,)).fetchone()
    assert row["status"] == "parsed"
    assert row["article_count"] == 6
    # 原文件已复制入库
    assert any(files_dir.glob("*"))


def test_import_duplicate_by_hash(db):
    conn, files_dir, tmp_path = db
    path = _make_docx(tmp_path, STATUTE, "民法典.docx")
    first = import_file(conn, path, files_dir)
    second = import_file(conn, path, files_dir)
    assert first.status == "imported"
    assert second.status == "duplicate"
    assert second.document_id == first.document_id
    count = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    assert count == 1


def test_import_doc_rejected_with_hint(db):
    conn, files_dir, tmp_path = db
    path = tmp_path / "旧格式.doc"
    path.write_bytes(b"\xd0\xcf\x11\xe0")
    result = import_file(conn, path, files_dir)
    assert result.status == "failed"
    assert "convert_doc" in result.message


def test_import_case_doc_becomes_chunks(db):
    conn, files_dir, tmp_path = db
    path = _make_docx(tmp_path, CASE, "判决书.docx")
    result = import_file(conn, path, files_dir)
    assert result.status == "imported"
    assert result.doc_type == "case"
    chunks = conn.execute(
        "SELECT COUNT(*) FROM chunks WHERE document_id=?", (result.document_id,)
    ).fetchone()[0]
    assert chunks >= 1


def test_import_degenerate_articles_marked_needs_review(db):
    # 条文切出来了但平均内容过短 → 切分可能出错，标记人工复查
    conn, files_dir, tmp_path = db
    degenerate = ["第一条 x。", "第二条 y。", "第三条 z。"]
    path = _make_docx(tmp_path, degenerate, "异常.docx")
    result = import_file(conn, path, files_dir)
    assert result.status == "imported"
    row = conn.execute("SELECT status FROM documents WHERE id=?", (result.document_id,)).fetchone()
    assert row["status"] == "needs_review"


def test_import_short_but_valid_excerpt_stays_parsed(db):
    # 只有 6 条但内容正常的节选 → 不应误标
    conn, files_dir, tmp_path = db
    path = _make_docx(tmp_path, STATUTE, "节选.docx")
    result = import_file(conn, path, files_dir)
    row = conn.execute("SELECT status FROM documents WHERE id=?", (result.document_id,)).fetchone()
    assert row["status"] == "parsed"


def test_chunk_paragraphs_merges_short_paragraphs():
    paragraphs = ["短段落一。", "短段落二。", "短段落三。"] * 30
    chunks = chunk_paragraphs(paragraphs, target=100)
    assert len(chunks) < len(paragraphs)
    assert all(len(c) >= 50 for c in chunks[:-1])
    assert "短段落一" in chunks[0]


def test_chunk_paragraphs_keeps_long_paragraph():
    paragraphs = ["这是一段超过目标长度的很长很长的段落。" * 20, "尾巴。"]
    chunks = chunk_paragraphs(paragraphs, target=100)
    assert len(chunks) >= 2
    assert chunks[0].startswith("这是一段")
