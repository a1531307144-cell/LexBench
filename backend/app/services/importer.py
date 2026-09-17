import hashlib
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

import pdfplumber
from docx import Document

from app.services.indexer import index_articles, index_chunks
from app.services.splitter import detect_doc_type, split_statute

_DATE_SUFFIX_RE = re.compile(r"[_\s\-]\d{4,8}$")
_MIN_AVG_ARTICLE_LEN = 20


@dataclass
class ImportResult:
    status: str  # imported | duplicate | failed
    title: str
    document_id: int = 0
    doc_type: str = ""
    article_count: int = 0
    message: str = ""


def _clean_title(filename: str) -> str:
    stem = Path(filename).stem
    cleaned = _DATE_SUFFIX_RE.sub("", stem).strip()
    return cleaned or stem


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def extract_docx_paragraphs(path) -> list:
    doc = Document(str(path))
    return [p.text for p in doc.paragraphs if p.text.strip()]


def extract_pdf_paragraphs(path) -> list:
    lines = []
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            for line in (page.extract_text() or "").splitlines():
                line = line.strip()
                if line:
                    lines.append(line)
    return lines


def chunk_paragraphs(paragraphs, target=500) -> list:
    """把段落合并为约 target 字符的检索块；剩余段落独立成块。"""
    chunks, buf, size = [], [], 0
    for p in paragraphs:
        buf.append(p)
        size += len(p)
        if size >= target:
            chunks.append("\n".join(buf))
            buf, size = [], 0
    if buf:
        chunks.append("\n".join(buf))
    return chunks


def import_file(conn, file_path, files_dir, category="", original_name=None) -> ImportResult:
    file_path = Path(file_path)
    files_dir = Path(files_dir)
    title = _clean_title(original_name or file_path.name)
    suffix = Path(original_name or file_path.name).suffix.lower()

    try:
        if suffix == ".docx":
            paragraphs = extract_docx_paragraphs(file_path)
        elif suffix == ".pdf":
            paragraphs = extract_pdf_paragraphs(file_path)
            if sum(len(p) for p in paragraphs) < 20:
                return ImportResult(
                    "failed", title, message="未检出文本层（可能是扫描版 PDF），暂不支持 OCR"
                )
        elif suffix == ".doc":
            return ImportResult(
                "failed", title, message="不支持 .doc 老格式，请先运行 scripts/convert_doc.py 转为 .docx"
            )
        else:
            return ImportResult("failed", title, message=f"不支持的文件类型 {suffix or '(无后缀)'}")
        if not paragraphs:
            return ImportResult("failed", title, message="文档内容为空")
    except Exception as e:  # 单文件解析失败不阻断批量导入
        return ImportResult("failed", title, message=f"解析失败：{e}")

    file_hash = _sha256(file_path)
    existing = conn.execute(
        "SELECT id FROM documents WHERE file_hash=?", (file_hash,)
    ).fetchone()
    if existing:
        return ImportResult("duplicate", title, document_id=existing["id"])

    doc_type = detect_doc_type(paragraphs)
    articles = split_statute(paragraphs) if doc_type == "statute" else []
    status = "parsed"
    if doc_type == "statute":
        avg = sum(len(a.content) for a in articles) / len(articles) if articles else 0
        if not articles or avg < _MIN_AVG_ARTICLE_LEN:
            status = "needs_review"

    cur = conn.execute(
        "INSERT INTO documents(title, doc_type, category, file_hash, original_path, status)"
        " VALUES(?,?,?,?,?,?)",
        (title, doc_type, category or "", file_hash, str(file_path), status),
    )
    conn.commit()
    doc_id = cur.lastrowid

    if doc_type == "statute":
        index_articles(conn, doc_id, articles)
    else:
        index_chunks(conn, doc_id, chunk_paragraphs(paragraphs))

    files_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(file_path, files_dir / f"{file_hash}{suffix}")

    return ImportResult(
        "imported", title, document_id=doc_id, doc_type=doc_type, article_count=len(articles)
    )
