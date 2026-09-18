import json
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.core.cn2num import cn2num
from app.services import retriever
from app.services.ai_provider import (
    AICallError,
    AINotConfigured,
    build_provider,
    load_ai_config,
)
from app.services.search import match_documents

router = APIRouter(tags=["ai"])

SYSTEM_PROMPT = (
    "你是一位严谨的中国法律研究助手。回答使用简体中文与 Markdown 格式。"
    "引用法条时必须写成《法规全名》第X条 的格式，且只能引用用户提供的材料中"
    "确实存在的条文，严禁编造法条号或法规名。材料中没有的内容要明确说明。"
)

_CITE_RE = re.compile(r"《([^《》]{1,60})》\s*第\s*([零〇一二三四五六七八九十百千\d]+)\s*条")


def _get_provider(request: Request):
    """构建 Provider；测试中会被 monkeypatch 替换。"""
    return build_provider(request.app.state.conn)


# ---------- 引用解析 ----------

def resolve_citations(conn, answer_md: str) -> list[dict]:
    """解析回答中的《法规名》第X条引用，关联到库内法条 id（可点击跳转）。"""
    resolved, seen = [], set()
    for m in _CITE_RE.finditer(answer_md):
        name, no_raw = m.group(1).strip(), m.group(2)
        no = cn2num(no_raw) if not no_raw.isdigit() else int(no_raw)
        if no is None:
            continue
        key = (name, no)
        if key in seen:
            continue
        seen.add(key)
        doc_ids = match_documents(conn, name)
        hit = None
        if doc_ids:
            placeholders = ",".join("?" * len(doc_ids))
            hit = conn.execute(
                f"SELECT a.id, a.article_label, d.title FROM articles a"
                f" JOIN documents d ON d.id=a.document_id"
                f" WHERE a.document_id IN ({placeholders}) AND a.article_no=?"
                f" ORDER BY a.order_index LIMIT 1",
                (*doc_ids, no),
            ).fetchone()
        if hit:
            resolved.append(
                {
                    "article_id": hit["id"],
                    "title": hit["title"],
                    "label": hit["article_label"],
                    "cite_text": m.group(0),
                }
            )
        else:
            resolved.append(
                {"article_id": None, "title": name, "label": f"第{no}条", "cite_text": m.group(0)}
            )
    return resolved


# ---------- 请求模型 ----------

class SettingsIn(BaseModel):
    base_url: str = ""
    model: str = ""
    api_key: str | None = None  # None/缺省 = 保持不变；非空 = 更新


class ExplainIn(BaseModel):
    article_id: int


class FollowupIn(BaseModel):
    article_id: int | None = None
    topic_id: int | None = None
    question: str


# ---------- 设置 ----------

def _mask(key: str) -> str:
    if not key:
        return ""
    return key[:3] + "*" * max(4, len(key) - 6) + key[-3:]


@router.get("/ai/settings")
def get_settings(request: Request):
    cfg = load_ai_config(request.app.state.conn)
    return {
        "base_url": cfg["base_url"],
        "model": cfg["model"],
        "api_key_set": bool(cfg["api_key"]),
        "api_key_masked": _mask(cfg["api_key"]),
    }


@router.put("/ai/settings")
def put_settings(body: SettingsIn, request: Request):
    conn = request.app.state.conn
    for key, value in (
        ("ai_base_url", body.base_url.strip()),
        ("ai_model", body.model.strip()),
    ):
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
    if body.api_key is not None and body.api_key.strip():
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            ("ai_api_key", body.api_key.strip()),
        )
    conn.commit()
    return {"ok": True}


@router.post("/ai/test")
def test_connection(request: Request):
    try:
        provider = _get_provider(request)
    except AINotConfigured as e:
        raise HTTPException(400, str(e))
    try:
        reply = provider.chat(
            [{"role": "user", "content": "请回复：连接正常"}]
        )
    except AICallError as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "reply": reply.strip()[:50]}


# ---------- 三操作 ----------

def _load_article(conn, article_id):
    row = retriever.get_article_or_404(conn, article_id)
    if row is None:
        raise HTTPException(404, "法条不存在")
    return row


def _history_messages(conn, article_id=None, topic_id=None, limit=6):
    """取最近问答作为追问的上下文（不含 citations 字段）。"""
    if article_id:
        rows = conn.execute(
            "SELECT action, question, answer_md FROM ai_messages"
            " WHERE article_id=? ORDER BY id DESC LIMIT ?",
            (article_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT action, question, answer_md FROM ai_messages"
            " WHERE topic_id=? ORDER BY id DESC LIMIT ?",
            (topic_id, limit),
        ).fetchall()
    msgs = []
    for r in reversed(rows):
        q = r["question"] or {"explain": "请解释这条法条", "cases": "请找相关案例"}.get(
            r["action"], ""
        )
        if q:
            msgs.append({"role": "user", "content": q[:400]})
        msgs.append({"role": "assistant", "content": r["answer_md"][:800]})
    return msgs


def _save_message(conn, article_id, topic_id, action, question, answer_md, citations):
    cur = conn.execute(
        "INSERT INTO ai_messages(article_id, topic_id, action, question, answer_md, citations)"
        " VALUES(?,?,?,?,?,?)",
        (article_id, topic_id, action, question, answer_md, json.dumps(citations, ensure_ascii=False)),
    )
    conn.commit()
    return cur.lastrowid


def _message_out(conn, row_id):
    r = conn.execute("SELECT * FROM ai_messages WHERE id=?", (row_id,)).fetchone()
    return {
        "id": r["id"],
        "article_id": r["article_id"],
        "topic_id": r["topic_id"],
        "action": r["action"],
        "question": r["question"],
        "answer_md": r["answer_md"],
        "citations": json.loads(r["citations"]),
        "created_at": r["created_at"],
    }


@router.post("/ai/explain")
def explain(body: ExplainIn, request: Request):
    conn = request.app.state.conn
    article = _load_article(conn, body.article_id)
    context = retriever.explain_context(conn, article)
    user_msg = (
        "请解释下面这条法条：分「条文主旨」「适用场景」「实务要点」三部分，"
        "语言平实、面向非法律专业人士。\n\n【材料】\n" + context
    )
    try:
        provider = _get_provider(request)
        answer = provider.chat(
            [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_msg}]
        )
    except AINotConfigured as e:
        raise HTTPException(400, str(e))
    except AICallError as e:
        raise HTTPException(502, str(e))
    citations = resolve_citations(conn, answer)
    mid = _save_message(conn, body.article_id, None, "explain", "", answer, citations)
    return _message_out(conn, mid)


@router.post("/ai/cases")
def cases(body: ExplainIn, request: Request):
    conn = request.app.state.conn
    article = _load_article(conn, body.article_id)
    context = retriever.cases_context(conn, article)
    if context:
        user_msg = (
            "请基于下面这条法条，结合【材料】中用户本地文档库的内容，"
            "归纳相关案例或适用情形；材料中没有案例时要如实说明，"
            "不要虚构。\n\n【目标法条】\n"
            f"《{article['title']}》{article['article_label']}\n{article['content']}"
            "\n\n【材料】\n" + context
        )
    else:
        user_msg = (
            "请围绕下面这条法条，说明该条通常涉及哪些典型纠纷类型与适用情形，"
            "并提示：用户本地文档库中暂未检索到相关案例材料。\n\n"
            f"《{article['title']}》{article['article_label']}\n{article['content']}"
        )
    try:
        provider = _get_provider(request)
        answer = provider.chat(
            [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_msg}]
        )
    except AINotConfigured as e:
        raise HTTPException(400, str(e))
    except AICallError as e:
        raise HTTPException(502, str(e))
    citations = resolve_citations(conn, answer)
    mid = _save_message(conn, body.article_id, None, "cases", "", answer, citations)
    return _message_out(conn, mid)


@router.post("/ai/followup")
def followup(body: FollowupIn, request: Request):
    conn = request.app.state.conn
    if not body.article_id and not body.topic_id:
        raise HTTPException(422, "需指定 article_id 或 topic_id")
    question = body.question.strip()
    if not question:
        raise HTTPException(422, "问题不能为空")

    context_block = ""
    if body.article_id:
        article = _load_article(conn, body.article_id)
        context_block = (
            f"【当前条文】\n《{article['title']}》{article['article_label']}\n"
            f"{article['content']}\n\n"
        )

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    history = _history_messages(conn, body.article_id, body.topic_id)
    if history:
        messages += history
    messages.append({"role": "user", "content": context_block + question})

    try:
        provider = _get_provider(request)
        answer = provider.chat(messages)
    except AINotConfigured as e:
        raise HTTPException(400, str(e))
    except AICallError as e:
        raise HTTPException(502, str(e))
    citations = resolve_citations(conn, answer)
    mid = _save_message(conn, body.article_id, body.topic_id, "followup", question, answer, citations)
    return _message_out(conn, mid)


@router.get("/ai/history")
def history(
    request: Request,
    article_id: int = None,
    topic_id: int = None,
):
    conn = request.app.state.conn
    if article_id:
        rows = conn.execute(
            "SELECT id FROM ai_messages WHERE article_id=? ORDER BY id", (article_id,)
        ).fetchall()
    elif topic_id:
        rows = conn.execute(
            "SELECT id FROM ai_messages WHERE topic_id=? ORDER BY id", (topic_id,)
        ).fetchall()
    else:
        raise HTTPException(422, "需指定 article_id 或 topic_id")
    return [_message_out(conn, r["id"]) for r in rows]


@router.delete("/ai/messages/{message_id}")
def delete_message(message_id: int, request: Request):
    conn = request.app.state.conn
    cur = conn.execute("DELETE FROM ai_messages WHERE id=?", (message_id,))
    conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "消息不存在")
    return {"ok": True}
