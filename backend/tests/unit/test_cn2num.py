import pytest

from app.core.cn2num import cn2num


@pytest.mark.parametrize(
    "cn, expected",
    [
        ("一", 1),
        ("九", 9),
        ("十", 10),
        ("十一", 11),
        ("二十", 20),
        ("二十一", 21),
        ("五十", 50),
        ("一百", 100),
        ("一百零一", 101),
        ("一百二十", 120),
        ("一百二十一", 121),
        ("一百零八", 108),
        ("二百零五", 205),
        ("一千", 1000),
        ("一千零一", 1001),
        ("一千零七十七", 1077),
        ("一千零八十", 1080),
        ("一千二百六十", 1260),
        ("二千零五", 2005),
        ("九千九百九十九", 9999),
        ("〇", 0),  # "第〇条" 不应出现，但零值容错
        ("零", 0),
    ],
)
def test_cn2num_chinese_numerals(cn, expected):
    assert cn2num(cn) == expected


def test_cn2num_arabic_passthrough():
    assert cn2num("1077") == 1077
    assert cn2num("51") == 51


def test_cn2num_invalid_returns_none():
    assert cn2num("") is None
    assert cn2num("abc") is None
    assert cn2num("一百X") is None
