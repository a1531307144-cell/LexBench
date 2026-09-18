import pytest

from app.db.connection import connect, init_db
from app.services.indexer import index_articles, index_chunks
from app.services.search import (
    highlight,
    make_snippet,
    search_fulltext,
    search_locate,
)
from app.services.splitter import Article


@pytest.fixture
def conn(tmp_path):
    db = tmp_path / "t.db"
    init_db(db)
    c = connect(db)
    _seed(c)
    yield c
    c.close()


def _insert_doc(conn, title, doc_type, category, file_hash):
    conn.execute(
        "INSERT INTO documents(title, doc_type, category, file_hash) VALUES(?,?,?,?)",
        (title, doc_type, category, file_hash),
    )
    return conn.execute(
        "SELECT id FROM documents WHERE file_hash=?", (file_hash,)
    ).fetchone()[0]


def _seed(conn):
    doc1 = _insert_doc(conn, "中华人民共和国民法典", "statute", "民法典", "h1")
    index_articles(
        conn,
        doc1,
        [
            Article(label="第一条", no=1, content="为了保护民事主体的合法权益，调整民事关系。"),
            Article(
                label="第一千零七十七条",
                no=1077,
                content="自婚姻登记机关收到离婚登记申请之日起三十日内，任何一方不愿意离婚的，可以向婚姻登记机关撤回离婚登记申请。",
            ),
            Article(
                label="第一千零八十七条",
                no=1087,
                content="离婚时，夫妻的共同财产由双方协议处理；协议不成的，由人民法院判决。",
            ),
        ],
    )
    doc2 = _insert_doc(conn, "中华人民共和国公司法", "statute", "公司法", "h2")
    index_articles(
        conn,
        doc2,
        [Article(label="第五十一条", no=51, content="有限责任公司设监事会，其成员不得少于三人。")],
    )
    doc3 = _insert_doc(conn, "某某离婚纠纷判决书", "case", "民法典", "h3")
    index_chunks(conn, doc3, ["关于离婚冷静期的适用：三十日内任何一方可以撤回申请。"])


# ---------- 定位检索 ----------

def test_locate_hint_and_number(conn):
    results = search_locate(conn, "民法典 1077")
    assert len(results) == 1
    r = results[0]
    assert r["label"] == "第一千零七十七条"
    assert r["title"] == "中华人民共和国民法典"
    assert r["kind"] == "article"


def test_locate_fuzzy_hint_by_subsequence(conn):
    # "民典" 是 "中华人民共和国民法典" 的子序列
    results = search_locate(conn, "民典 1077")
    assert len(results) == 1
    assert results[0]["label"] == "第一千零七十七条"


def test_locate_no_hint_searches_all(conn):
    results = search_locate(conn, "51")
    assert len(results) == 1
    assert results[0]["title"] == "中华人民共和国公司法"


def test_locate_unknown_number_returns_empty(conn):
    assert search_locate(conn, "民法典 9999") == []


def test_locate_returns_plain_content(conn):
    results = search_locate(conn, "民法典 1077")
    assert "三十日内" in results[0]["content"]


# ---------- 全文检索 ----------

def test_fulltext_finds_article_with_highlight(conn):
    results = search_fulltext(conn, "离婚 冷静期")
    labels = [r["label"] for r in results]
    assert "第一千零七十七条" in labels
    r = next(r for r in results if r["label"] == "第一千零七十七条")
    assert "<em>离婚</em>" in r["snippet"]


def test_fulltext_finds_case_chunk(conn):
    results = search_fulltext(conn, "冷静期")
    kinds = {(r["kind"], r["title"]) for r in results}
    assert ("chunk", "某某离婚纠纷判决书") in kinds


def test_fulltext_filter_doc_type(conn):
    results = search_fulltext(conn, "离婚", doc_type="statute")
    assert all(r["kind"] == "article" for r in results)
    assert all(r["title"] != "某某离婚纠纷判决书" for r in results)


def test_fulltext_filter_category(conn):
    results = search_fulltext(conn, "撤回", category="民法典")
    assert results
    assert all(r["category"] == "民法典" for r in results)


def test_fulltext_no_token_returns_empty(conn):
    assert search_fulltext(conn, "  ") == []


# ---------- 高亮与摘要 ----------

def test_highlight_marks_all_tokens():
    assert (
        highlight("离婚冷静期制度，离婚登记", ["离婚"])
        == "<em>离婚</em>冷静期制度，<em>离婚</em>登记"
    )


def test_highlight_escapes_html_in_content():
    # 文档内容含 HTML 片段时先转义再高亮，防止 v-html 注入
    out = highlight("<script>离婚</script>", ["离婚"])
    assert out == "&lt;script&gt;<em>离婚</em>&lt;/script&gt;"


def test_highlight_longer_token_first():
    assert highlight("冷静期", ["冷静", "冷静期"]) == "<em>冷静期</em>"


def test_make_snippet_contains_hit_and_ellipsis():
    content = "前" * 100 + "离婚时财产分割" + "后" * 100
    s = make_snippet(content, ["离婚"])
    assert "<em>离婚</em>" in s
    assert s.startswith("…") and s.endswith("…")
    assert len(s) < len(content)
