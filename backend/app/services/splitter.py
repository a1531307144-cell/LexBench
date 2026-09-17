import re
from dataclasses import dataclass

from app.core.cn2num import cn2num

_NUM = r"[零〇一二三四五六七八九十百千\d]+"
ARTICLE_RE = re.compile(rf"^第({_NUM})条(之[一二三四五六七八九十])?\s*")
BRANCH_RE = re.compile(rf"^第({_NUM})编\s*\S")
CHAPTER_RE = re.compile(rf"^第({_NUM})章\s*\S")
SECTION_RE = re.compile(rf"^第({_NUM})节\s*\S")
CASE_NO_RE = re.compile(r"[（(]\s*\d{4}\s*[）)].{0,20}?号")
_CASE_TEXT_RE = re.compile(r"判决书|裁定书|裁判要旨|仲裁裁决")
_STATUTE_MIN_ARTICLES = 3


@dataclass
class Article:
    label: str = ""
    no: int = 0
    branch: str = ""
    chapter: str = ""
    section: str = ""
    content: str = ""
    order_index: int = 0


def split_statute(paragraphs):
    """把法规文档段落切分为法条列表；编/章/节标题行更新层级状态。"""
    articles = []
    current = None
    branch = chapter = section = ""
    for raw in paragraphs:
        p = raw.strip()
        if not p:
            continue
        m = ARTICLE_RE.match(p)
        if m:
            if current is not None:
                articles.append(current)
            current = Article(
                label=f"第{m.group(1)}条{m.group(2) or ''}",
                no=cn2num(m.group(1)) or 0,
                branch=branch,
                chapter=chapter,
                section=section,
                content=p[m.end():].strip(),
            )
            continue
        if BRANCH_RE.match(p):
            branch = p
        elif CHAPTER_RE.match(p):
            chapter = p
        elif SECTION_RE.match(p):
            section = p
        elif current is not None:
            current.content += "\n" + p
    if current is not None:
        articles.append(current)
    for i, a in enumerate(articles):
        a.order_index = i
    return articles


def detect_doc_type(paragraphs):
    """识别文档类型：statute | case | other。"""
    article_starts = sum(1 for p in paragraphs if ARTICLE_RE.match(p.strip()))
    if article_starts >= _STATUTE_MIN_ARTICLES:
        return "statute"
    text = "\n".join(paragraphs)
    if CASE_NO_RE.search(text) or _CASE_TEXT_RE.search(text):
        return "case"
    return "other"
