"""M3 AI 助手测试：设置（密钥脱敏）、三操作（FakeProvider）、引用解析、历史。"""
import pytest
from fastapi.testclient import TestClient

from tests.api.test_api import STATUTE, _docx_bytes


class FakeProvider:
    """替身 Provider：脚本化返回，绝不发真实网络请求。"""

    reply = "这是模拟回答。参见《中华人民共和国民法典》第一千零七十七条。"

    def chat(self, messages):
        FakeProvider.captured = messages
        return FakeProvider.reply


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app.main import create_app
    from app.routers import ai as ai_router

    monkeypatch.setattr(ai_router, "_get_provider", lambda request: FakeProvider())
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
    doc_id = client.get("/api/documents").json()[0]["id"]
    detail = client.get(f"/api/documents/{doc_id}").json()
    return next(a["id"] for a in detail["articles"] if a["article_no"] == 1077)


# ---------- 设置 ----------

def test_settings_roundtrip_and_masking(client):
    assert client.get("/api/ai/settings").json() == {
        "base_url": "",
        "model": "",
        "api_key_set": False,
        "api_key_masked": "",
    }

    client.put(
        "/api/ai/settings",
        json={"base_url": "https://api.example.com/v1", "model": "demo-model", "api_key": "fake-key-0123456789abcdef"},
    )
    body = client.get("/api/ai/settings").json()
    assert body["base_url"] == "https://api.example.com/v1"
    assert body["model"] == "demo-model"
    assert body["api_key_set"] is True
    # 关键安全要求：GET 绝不返回完整密钥
    masked = body["api_key_masked"]
    assert "0123456789abcdef" not in masked
    assert masked.startswith("fak") and "*" in masked

    # api_key 缺省 = 保持不变
    client.put("/api/ai/settings", json={"model": "another-model"})
    body = client.get("/api/ai/settings").json()
    assert body["model"] == "another-model"
    assert body["api_key_set"] is True


def test_test_connection_uses_provider(client):
    resp = client.post("/api/ai/test")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


# ---------- 三操作 ----------

def test_explain_saves_with_resolved_citation(client, article_id):
    resp = client.post("/api/ai/explain", json={"article_id": article_id})
    assert resp.status_code == 200
    body = resp.json()
    assert body["action"] == "explain"
    assert "这是模拟回答" in body["answer_md"]
    # 引用《中华人民共和国民法典》第一千零七十七条 应解析为可点击的库内法条
    assert body["citations"][0]["article_id"] == article_id
    assert body["citations"][0]["label"] == "第一千零七十七条"
    # 提示词约束：系统消息要求禁止编造
    sys_msg = FakeProvider.captured[0]["content"]
    assert "严禁编造" in sys_msg


def test_explain_404(client):
    assert client.post("/api/ai/explain", json={"article_id": 99999}).status_code == 404


def test_cases_action(client, article_id):
    resp = client.post("/api/ai/cases", json={"article_id": article_id})
    assert resp.status_code == 200
    assert resp.json()["action"] == "cases"


def test_followup_with_history_context(client, article_id):
    client.post("/api/ai/explain", json={"article_id": article_id})
    resp = client.post(
        "/api/ai/followup",
        json={"article_id": article_id, "question": "冷静期能否_skip？实践中如何计算？"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["action"] == "followup"
    assert body["question"].startswith("冷静期")

    # 追问请求应带上历史问答作为上下文
    roles = [m["role"] for m in FakeProvider.captured]
    assert roles == ["system", "user", "assistant", "user"]

    blank = client.post(
        "/api/ai/followup", json={"article_id": article_id, "question": "  "}
    )
    assert blank.status_code == 422
    neither = client.post("/api/ai/followup", json={"question": "x"})
    assert neither.status_code == 422


def test_followup_on_topic(client, article_id):
    topic = client.post("/api/topics", json={"name": "AI 专题"}).json()
    resp = client.post(
        "/api/ai/followup",
        json={"topic_id": topic["id"], "question": "这个专题的研究思路？"},
    )
    assert resp.status_code == 200
    assert resp.json()["topic_id"] == topic["id"]


# ---------- 历史与删除 ----------

def test_history_grouped_and_deletable(client, article_id):
    client.post("/api/ai/explain", json={"article_id": article_id})
    client.post("/api/ai/cases", json={"article_id": article_id})
    doc_id = client.get("/api/documents").json()[0]["id"]
    detail = client.get(f"/api/documents/{doc_id}").json()
    first_article = next(a["id"] for a in detail["articles"] if a["article_no"] == 1)
    client.post("/api/ai/followup", json={"article_id": first_article, "question": "问2"})

    hist = client.get("/api/ai/history", params={"article_id": article_id}).json()
    assert len(hist) == 2  # 第一条的追问属于另一组
    assert [h["action"] for h in hist] == ["explain", "cases"]

    mid = hist[0]["id"]
    assert client.delete(f"/api/ai/messages/{mid}").status_code == 200
    assert client.delete(f"/api/ai/messages/{mid}").status_code == 404
    assert len(client.get("/api/ai/history", params={"article_id": article_id}).json()) == 1

    assert client.get("/api/ai/history").status_code == 422


def test_unresolved_citation_not_clickable(client, article_id):
    FakeProvider.reply = "参见《不存在的虚构法》第九十九条的规定。"
    try:
        body = client.post("/api/ai/explain", json={"article_id": article_id}).json()
        cite = body["citations"][0]
        assert cite["article_id"] is None
        assert cite["title"] == "不存在的虚构法"
    finally:
        FakeProvider.reply = "这是模拟回答。参见《中华人民共和国民法典》第一千零七十七条。"
