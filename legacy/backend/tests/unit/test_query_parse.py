import pytest

from app.services.search import parse_locate_query


@pytest.mark.parametrize(
    "query, expected_hint, expected_no",
    [
        ("民法典 1077", "民法典", 1077),
        ("公司法 第51条", "公司法", 51),
        ("婚姻家庭编解释一 69", "婚姻家庭编解释一", 69),
        ("民法典1077", "民法典", 1077),
        ("民法典第一千零七十七条", "民法典", 1077),
        ("第1077条", "", 1077),
        ("1077", "", 1077),
        ("民法典 第1077条", "民法典", 1077),
    ],
)
def test_parse_locate_valid(query, expected_hint, expected_no):
    result = parse_locate_query(query)
    assert result is not None
    assert result.hint == expected_hint
    assert result.article_no == expected_no


@pytest.mark.parametrize(
    "query",
    ["离婚 冷静期", "民法典", "", "劳动法加班费"],
)
def test_parse_locate_invalid(query):
    assert parse_locate_query(query) is None
