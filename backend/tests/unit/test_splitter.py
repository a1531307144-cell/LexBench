from app.services.splitter import detect_doc_type, split_statute

STATUTE_PARAGRAPHS = [
    "中华人民共和国民法典",
    "第一编 总则",
    "第一章 基本规定",
    "第一条 为了保护民事主体的合法权益，调整民事关系，维护社会和经济秩序，适应中国特色社会主义发展要求，弘扬社会主义核心价值观，根据宪法，制定本法。",
    "第二条 民法调整平等主体的自然人、法人和非法人组织之间的人身关系和财产关系。",
    "第一编 物权",
    "第二章 其他规定",
    "第一百条之一 本编规定的情形，适用本编的规定。",
    "第一千零七十七条 自婚姻登记机关收到离婚登记申请之日起三十日内，任何一方不愿意离婚的，可以向婚姻登记机关撤回离婚登记申请。",
    "前款规定期间届满后三十日内，双方应当亲自到婚姻登记机关申请发给离婚证；未申请的，视为撤回离婚登记申请。",
]


def test_split_statute_basic():
    articles = split_statute(STATUTE_PARAGRAPHS)
    assert len(articles) == 4
    first = articles[0]
    assert first.label == "第一条"
    assert first.no == 1
    assert first.branch == "第一编 总则"
    assert first.chapter == "第一章 基本规定"
    assert first.content.startswith("为了保护民事主体")


def test_split_statute_hierarchy_updates():
    articles = split_statute(STATUTE_PARAGRAPHS)
    # 编/章切换后，后续条文继承新层级
    last = articles[-1]
    assert last.branch == "第一编 物权"
    assert last.chapter == "第二章 其他规定"


def test_split_statute_merges_continuation_paragraphs():
    articles = split_statute(STATUTE_PARAGRAPHS)
    last = articles[-1]
    # 第1077条两段合并，中间以换行分隔
    assert "前款规定期间届满后" in last.content
    assert last.content.count("\n") == 1


def test_split_statute_zhi_suffix():
    articles = split_statute(STATUTE_PARAGRAPHS)
    zhi = articles[2]
    assert zhi.label == "第一百条之一"
    assert zhi.no == 100


def test_split_statute_chinese_no_conversion():
    articles = split_statute(STATUTE_PARAGRAPHS)
    assert articles[-1].no == 1077
    assert articles[-1].label == "第一千零七十七条"


def test_split_statute_inline_reference_does_not_split():
    paragraphs = [
        "第一条 内容。",
        "当事人应当依照本法第五百零九条的规定履行义务。",
    ]
    articles = split_statute(paragraphs)
    assert len(articles) == 1
    assert "第五百零九条" in articles[0].content


def test_split_statute_arabic_article_number():
    paragraphs = ["第1077条 自婚姻登记机关收到离婚登记申请之日起三十日内。"]
    articles = split_statute(paragraphs)
    assert len(articles) == 1
    assert articles[0].no == 1077


def test_split_statute_empty():
    assert split_statute([]) == []


def test_detect_doc_type_statute():
    assert detect_doc_type(STATUTE_PARAGRAPHS) == "statute"


def test_detect_doc_type_case():
    paragraphs = [
        "北京市海淀区人民法院民事判决书",
        "（2023）京0108民初12345号",
        "裁判要旨：夫妻共同债务的认定应当……",
        "本院认为，……",
    ]
    assert detect_doc_type(paragraphs) == "case"


def test_detect_doc_type_other():
    paragraphs = ["关于民法典的学习笔记", "离婚冷静期制度的来龙去脉。"]
    assert detect_doc_type(paragraphs) == "other"
