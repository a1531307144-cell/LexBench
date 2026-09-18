"""M1 验收：用真实法律文档库验证导入与双模式检索。

运行方式（仅本机，路径通过环境变量注入，避免个人路径进入代码）:
    PowerShell:  $env:LEXBENCH_REAL_DOCS = "D:\你的文档库路径"; pytest backend/tests
未设置该环境变量时自动跳过（CI 与其他开发者环境无真实数据）。
"""

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_env = os.environ.get("LEXBENCH_REAL_DOCS", "").strip()
REAL_DOCS = Path(_env) if _env else None

pytestmark = pytest.mark.skipif(
    REAL_DOCS is None or not REAL_DOCS.is_dir(),
    reason="未设置 LEXBENCH_REAL_DOCS 环境变量，跳过真实文档库验收",
)


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from app.main import create_app

    tmp = tmp_path_factory.mktemp("real_docs")
    app = create_app(db_path=tmp / "db.sqlite", files_dir=tmp / "files")
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def imported_library(client):
    files = sorted(REAL_DOCS.rglob("*.docx")) + sorted(REAL_DOCS.rglob("*.pdf"))
    assert len(files) >= 35, f"预期 35+ 文档，实际 {len(files)}"
    results = []
    for f in files:
        with open(f, "rb") as fh:
            resp = client.post(
                "/api/documents",
                files={"files": (f.name, fh.read(), "application/octet-stream")},
            )
        assert resp.status_code == 200
        results.append((f, resp.json()["results"][0]))
    return results


def test_import_real_library(client, imported_library):
    imported = [r for _, r in imported_library if r["status"] == "imported"]
    failed = [(f.name, r["message"]) for f, r in imported_library if r["status"] == "failed"]
    statutes = [r for r in imported if r["doc_type"] == "statute"]

    print(f"\n=== 真实文档库导入统计 ===")
    print(f"总计 {len(imported_library)} 份，导入成功 {len(imported)}，失败 {len(failed)}")
    print(f"识别为法规 {len(statutes)} 份：")
    for r in statutes:
        print(f"  - {r['title']}（{r['article_count']} 条）")
    if failed:
        print("失败列表：")
        for name, msg in failed:
            print(f"  x {name}: {msg}")

    assert len(imported) >= 35, "大部分文档应导入成功"
    assert len(statutes) >= 8, "应识别出多部法规"
    # 民法典必须切出接近 1260 条
    minfadian = next(r for r in statutes if "民法典" in r["title"] and "解释" not in r["title"])
    assert 1200 <= minfadian["article_count"] <= 1300, (
        f"民法典应切出约 1260 条，实际 {minfadian['article_count']}"
    )


def test_acceptance_locate_1077(client, imported_library):
    """验收一：输入"民法典 1077"直接定位到第一千零七十七条。"""
    resp = client.get("/api/search", params={"q": "民法典 1077"})
    body = resp.json()
    assert body["mode"] == "locate"
    top = body["results"][0]
    assert top["label"] == "第一千零七十七条"
    assert "三十日内" in top["content"]
    assert "撤回离婚登记申请" in top["content"]


def test_acceptance_fulltext_lihun_lengjingqi(client, imported_library):
    """验收二：输入"离婚 冷静期"全文搜索命中第1077条。"""
    resp = client.get("/api/search", params={"q": "离婚 冷静期"})
    body = resp.json()
    assert body["mode"] == "fulltext"
    hit = [r for r in body["results"] if r.get("label") == "第一千零七十七条"]
    assert hit, "第1077条应出现在'离婚 冷静期'的检索结果中"
    assert "<em>离婚</em>" in hit[0]["snippet"]


def test_acceptance_locate_company_law(client, imported_library):
    """附加：公司法模糊定位。"""
    resp = client.get("/api/search", params={"q": "公司法 51"})
    body = resp.json()
    assert body["mode"] == "locate"
    assert body["results"][0]["label"] in ("第五十一条", "第五十一条之一")


def test_acceptance_research_workflow(client, imported_library):
    """U4/U6 验收：检索 → 收藏到专题 → 笔记 → 导出研究报告。"""
    hit = client.get("/api/search", params={"q": "民法典 1077"}).json()
    article_id = hit["results"][0]["id"]

    topic = client.post(
        "/api/topics", json={"name": "婚姻家事研究", "description": "验收专题"}
    ).json()
    tid = topic["id"]
    assert client.post(f"/api/topics/{tid}/items", json={"article_id": article_id}).json()[
        "status"
    ] == "added"
    client.post(
        "/api/notes",
        json={
            "topic_id": tid,
            "article_id": article_id,
            "content_md": "**要点**：冷静期 30 日内可撤回离婚登记申请",
        },
    )

    md = client.get(f"/api/topics/{tid}/export").text
    assert "第一千零七十七条（中华人民共和国民法典）" in md
    assert "三十日内" in md
    assert "冷静期 30 日内可撤回离婚登记申请" in md
    assert client.delete(f"/api/topics/{tid}").json()["ok"]
