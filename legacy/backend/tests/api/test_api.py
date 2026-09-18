import io

import pytest
from docx import Document
from fastapi.testclient import TestClient


def _docx_bytes(paragraphs) -> bytes:
    doc = Document()
    for p in paragraphs:
        doc.add_paragraph(p)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


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


@pytest.fixture
def client(tmp_path):
    from app.main import create_app

    app = create_app(db_path=tmp_path / "db.sqlite", files_dir=tmp_path / "files")
    with TestClient(app) as c:
        yield c


@pytest.fixture
def imported(client):
    resp = client.post(
        "/api/documents",
        files={"files": ("中华人民共和国民法典_节选.docx", _docx_bytes(STATUTE), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
        data={"category": "民法典"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["results"][0]["status"] == "imported"
    return body["results"][0]


def test_upload_imports_statute(imported):
    assert imported["doc_type"] == "statute"
    assert imported["article_count"] == 6
    assert imported["title"] == "中华人民共和国民法典_节选"


def test_list_documents(imported, client):
    resp = client.get("/api/documents")
    assert resp.status_code == 200
    docs = resp.json()
    assert len(docs) == 1
    assert docs[0]["title"] == "中华人民共和国民法典_节选"
    assert docs[0]["category"] == "民法典"


def test_upload_duplicate_reports(imported, client):
    resp = client.post(
        "/api/documents",
        files={"files": ("民法典_节选.docx", _docx_bytes(STATUTE), "application/octet-stream")},
    )
    assert resp.json()["results"][0]["status"] == "duplicate"


def test_search_locate_mode(imported, client):
    resp = client.get("/api/search", params={"q": "民法典 1077"})
    body = resp.json()
    assert body["mode"] == "locate"
    assert body["results"][0]["label"] == "第一千零七十七条"
    assert "三十日内" in body["results"][0]["content"]


def test_search_fulltext_mode_with_highlight(imported, client):
    resp = client.get("/api/search", params={"q": "离婚 冷静期"})
    body = resp.json()
    assert body["mode"] == "fulltext"
    r = next(r for r in body["results"] if r["label"] == "第一千零七十七条")
    assert "<em>离婚</em>" in r["snippet"]


def test_search_locate_miss_falls_back_to_fulltext(imported, client):
    resp = client.get("/api/search", params={"q": "民法典 99999"})
    body = resp.json()
    assert body["mode"] == "fulltext"  # 定位无结果自动降级


def test_document_detail(imported, client):
    resp = client.get(f"/api/documents/{imported['document_id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["title"] == "中华人民共和国民法典_节选"
    assert len(body["articles"]) == 6
    assert body["articles"][-1]["article_no"] == 1077


def test_article_with_neighbors(imported, client):
    list_resp = client.get(f"/api/documents/{imported['document_id']}")
    articles = list_resp.json()["articles"]
    last_id = articles[-1]["id"]
    resp = client.get(f"/api/articles/{last_id}")
    body = resp.json()
    assert body["label"] == "第一千零七十七条"
    assert body["prev"]["label"] == "第五条"
    assert body["next"] is None


def test_delete_document_cascades(imported, client):
    doc_id = imported["document_id"]
    resp = client.delete(f"/api/documents/{doc_id}")
    assert resp.status_code == 200
    assert len(client.get("/api/documents").json()) == 0
    # 索引一并清理：全文检索不再命中
    resp = client.get("/api/search", params={"q": "离婚"})
    assert resp.json()["results"] == []


CASE = [
    "北京市海淀区人民法院民事判决书",
    "（2023）京0108民初12345号",
    "本院认为，离婚冷静期制度旨在减少冲动离婚，三十日内可撤回申请。",
]


def test_case_document_detail_includes_chunks(client):
    resp = client.post(
        "/api/documents",
        files={"files": ("判决书.docx", _docx_bytes(CASE), "application/octet-stream")},
    )
    doc_id = resp.json()["results"][0]["document_id"]
    detail = client.get(f"/api/documents/{doc_id}").json()
    assert detail["doc_type"] == "case"
    assert detail["articles"] == []
    assert len(detail["chunks"]) >= 1
    assert "离婚冷静期" in detail["chunks"][0]["content"]


# ---------- 纯文本（.txt）导入 ----------

def test_upload_txt_imports_statute(client):
    resp = client.post(
        "/api/documents",
        files={"files": ("民法典节选.txt", "\n".join(STATUTE).encode("utf-8"), "text/plain")},
    )
    body = resp.json()["results"][0]
    assert body["status"] == "imported"
    assert body["doc_type"] == "statute"
    assert body["article_count"] == 6
    located = client.get("/api/search", params={"q": "民法典 1077"}).json()
    assert located["results"][0]["label"] == "第一千零七十七条"


def test_upload_txt_gbk_encoding(client):
    """常见 GBK 编码的中文 txt 也能正确导入。"""
    resp = client.post(
        "/api/documents",
        files={"files": ("判决书_gbk.txt", "\n".join(CASE).encode("gbk"), "text/plain")},
    )
    body = resp.json()["results"][0]
    assert body["status"] == "imported"
    assert body["doc_type"] == "case"
    hits = client.get("/api/search", params={"q": "冷静期"}).json()["results"]
    assert hits, "GBK 解码失败会导致全文检索无结果"


def test_bundled_samples_import_cleanly(client):
    """仓库自带 samples/ 必须能干净导入：法条数、类型、两类检索全链路可用。"""
    from pathlib import Path

    samples = Path(__file__).resolve().parents[3] / "samples"
    statute = samples / "中华人民共和国民法典_婚姻家庭编节选.txt"
    case = samples / "示例案例_离婚纠纷_虚构演示.txt"
    resp = client.post(
        "/api/documents",
        files=[
            ("files", (statute.name, statute.read_bytes(), "text/plain")),
            ("files", (case.name, case.read_bytes(), "text/plain")),
        ],
    )
    results = {r["title"]: r for r in resp.json()["results"]}
    statute_r = results["中华人民共和国民法典_婚姻家庭编节选"]
    assert statute_r["status"] == "imported"
    assert statute_r["article_count"] == 32
    case_r = results["示例案例_离婚纠纷_虚构演示"]
    assert case_r["status"] == "imported"
    assert case_r["doc_type"] == "case"

    located = client.get("/api/search", params={"q": "民法典 1077"}).json()
    assert located["results"][0]["label"] == "第一千零七十七条"
    fulltext = client.get("/api/search", params={"q": "离婚 冷静期"}).json()
    assert any(r["label"] == "第一千零七十七条" for r in fulltext["results"])
