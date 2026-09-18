"""M2 工作台 API 集成测试：专题 → 收藏 → 笔记 → 导出 → 删除 全流程（U4/U6）。"""
import io
import zipfile

import pytest
from docx import Document
from fastapi.testclient import TestClient

from tests.api.test_api import STATUTE, _docx_bytes


@pytest.fixture
def client(tmp_path):
    from app.main import create_app

    app = create_app(db_path=tmp_path / "db.sqlite", files_dir=tmp_path / "files")
    with TestClient(app) as c:
        yield c


@pytest.fixture
def article_id(client):
    resp = client.post(
        "/api/documents",
        files={"files": ("中华人民共和国民法典_节选.docx", _docx_bytes(STATUTE), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
    )
    assert resp.status_code == 200
    rows = client.get("/api/documents").json()
    doc_id = rows[0]["id"]
    detail = client.get(f"/api/documents/{doc_id}").json()
    return next(a["id"] for a in detail["articles"] if a["article_no"] == 1077)


@pytest.fixture
def topic(client, article_id):
    resp = client.post(
        "/api/topics", json={"name": "离婚财产分割", "description": "研究共同财产认定"}
    )
    assert resp.status_code == 201
    return resp.json()


def test_topic_crud(client, topic):
    assert topic["name"] == "离婚财产分割"
    assert topic["item_count"] == 0

    dup = client.post("/api/topics", json={"name": "离婚财产分割"})
    assert dup.status_code == 409

    empty = client.post("/api/topics", json={"name": "  "})
    assert empty.status_code == 422

    renamed = client.put(
        f"/api/topics/{topic['id']}", json={"name": "婚姻家事", "description": "更名"}
    )
    assert renamed.status_code == 200
    detail = client.get(f"/api/topics/{topic['id']}").json()
    assert detail["name"] == "婚姻家事"

    assert client.delete(f"/api/topics/{topic['id']}").status_code == 200
    assert client.get(f"/api/topics/{topic['id']}").status_code == 404


def test_favorite_and_topic_browse(client, topic, article_id):
    tid = topic["id"]
    added = client.post(f"/api/topics/{tid}/items", json={"article_id": article_id})
    assert added.status_code == 200
    assert added.json()["status"] == "added"

    dup = client.post(f"/api/topics/{tid}/items", json={"article_id": article_id})
    assert dup.json()["status"] == "duplicate"

    missing = client.post(f"/api/topics/{tid}/items", json={"article_id": 99999})
    assert missing.status_code == 404

    detail = client.get(f"/api/topics/{tid}").json()
    assert len(detail["items"]) == 1
    item = detail["items"][0]
    assert item["article_id"] == article_id
    assert item["label"] == "第一千零七十七条"
    assert item["title"] == "中华人民共和国民法典_节选"
    assert "三十日内" in item["content"]

    assert client.delete(f"/api/topics/{tid}/items/{article_id}").status_code == 200
    assert client.get(f"/api/topics/{tid}").json()["items"] == []
    assert client.delete(f"/api/topics/{tid}/items/{article_id}").status_code == 404


def test_note_crud(client, topic, article_id):
    tid = topic["id"]
    note = client.post(
        "/api/notes",
        json={"topic_id": tid, "article_id": article_id, "content_md": "冷静期 30 天，注意起算点"},
    )
    assert note.status_code == 201
    nid = note.json()["id"]

    blank = client.post("/api/notes", json={"topic_id": tid, "content_md": "  "})
    assert blank.status_code == 422
    bad_article = client.post(
        "/api/notes", json={"topic_id": tid, "article_id": 99999, "content_md": "x"}
    )
    assert bad_article.status_code == 404

    detail = client.get(f"/api/topics/{tid}").json()
    assert detail["notes"][0]["content_md"] == "冷静期 30 天，注意起算点"

    upd = client.put(f"/api/notes/{nid}", json={"content_md": "修订：30 日为自然日"})
    assert upd.status_code == 200
    assert client.get(f"/api/topics/{tid}").json()["notes"][0]["content_md"] == "修订：30 日为自然日"

    assert client.delete(f"/api/notes/{nid}").status_code == 200
    assert client.get(f"/api/topics/{tid}").json()["notes"] == []
    assert client.delete(f"/api/notes/{nid}").status_code == 404


def test_export_markdown_and_docx(client, topic, article_id):
    tid = topic["id"]
    client.post(f"/api/topics/{tid}/items", json={"article_id": article_id})
    client.post(
        "/api/notes",
        json={"topic_id": tid, "article_id": article_id, "content_md": "**要点**：撤回权"},
    )
    client.post("/api/notes", json={"topic_id": tid, "content_md": "专题总笔记"})

    md = client.get(f"/api/topics/{tid}/export")
    assert md.status_code == 200
    text = md.text
    assert "# 离婚财产分割" in text
    assert "第一千零七十七条（中华人民共和国民法典_节选）" in text
    assert "三十日内" in text
    assert "**要点**：撤回权" in text
    assert "专题笔记" in text
    assert "专题总笔记" in text
    assert 'attachment' in md.headers["content-disposition"]

    docx = client.get(f"/api/topics/{tid}/export", params={"format": "docx"})
    assert docx.status_code == 200
    assert docx.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument"
    )
    zf = zipfile.ZipFile(io.BytesIO(docx.content))
    assert "word/document.xml" in zf.namelist()

    missing = client.get("/api/topics/99999/export")
    assert missing.status_code == 404


def test_delete_topic_cascades(client, topic, article_id):
    tid = topic["id"]
    client.post(f"/api/topics/{tid}/items", json={"article_id": article_id})
    client.post(
        "/api/notes",
        json={"topic_id": tid, "article_id": article_id, "content_md": "note"},
    )
    assert client.delete(f"/api/topics/{tid}").status_code == 200
    assert client.get("/api/topics").json() == []
    assert client.get(f"/api/articles/{article_id}").status_code == 200


def test_delete_document_keeps_notes(client, topic, article_id):
    """删除文档后：收藏随之消失，笔记保留但解除关联（SET NULL）。"""
    tid = topic["id"]
    client.post(f"/api/topics/{tid}/items", json={"article_id": article_id})
    client.post(
        "/api/notes",
        json={"topic_id": tid, "article_id": article_id, "content_md": "重要"},
    )
    doc_id = client.get("/api/documents").json()[0]["id"]
    assert client.delete(f"/api/documents/{doc_id}").status_code == 200

    detail = client.get(f"/api/topics/{tid}").json()
    assert detail["items"] == []
    assert len(detail["notes"]) == 1
    assert detail["notes"][0]["article_id"] is None
    assert detail["notes"][0]["content_md"] == "重要"


def test_article_manual_correction_and_reindex(client, article_id):
    body = client.get(f"/api/articles/{article_id}").json()
    assert "任何组织或者个人不得侵犯" not in body["content"]

    resp = client.put(
        f"/api/articles/{article_id}",
        json={"content": "第一千零七十七条 修正后的内容：涉及遗产继承的特殊规则。"},
    )
    assert resp.status_code == 200

    assert client.get(f"/api/articles/{article_id}").json()["content"].startswith(
        "第一千零七十七条 修正后的内容"
    )
    hit = client.get("/api/search", params={"q": "遗产继承 特殊规则"}).json()
    labels = [r["label"] for r in hit["results"]]
    assert "第一千零七十七条" in labels

    assert client.put("/api/articles/99999", json={"content": "x"}).status_code == 404
    assert client.put(f"/api/articles/{article_id}", json={"content": " "}).status_code == 422


def test_document_status_update(client, article_id):
    doc_id = client.get("/api/documents").json()[0]["id"]
    ok = client.put(f"/api/documents/{doc_id}/status", json={"status": "needs_review"})
    assert ok.status_code == 200
    assert client.get("/api/documents").json()[0]["status"] == "needs_review"

    bad = client.put(f"/api/documents/{doc_id}/status", json={"status": "bogus"})
    assert bad.status_code == 422
    assert client.put("/api/documents/99999/status", json={"status": "parsed"}).status_code == 404
