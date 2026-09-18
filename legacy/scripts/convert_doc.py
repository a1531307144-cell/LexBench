"""把 .doc 老格式批量转换为 .docx（需本机安装 Microsoft Word）。

依赖：pip install pywin32
用法：python scripts/convert_doc.py <目录或单个文件路径>
"""

import sys
from pathlib import Path

try:
    import win32com.client
except ImportError:
    sys.exit("请先安装 pywin32：pip install pywin32")


def convert(path: Path, word) -> None:
    out = path.with_suffix(".docx")
    if out.exists():
        print(f"已存在，跳过: {out.name}")
        return
    doc = word.Documents.Open(str(path.resolve()))
    doc.SaveAs2(str(out.resolve()), FileFormat=16)  # 16 = wdFormatXMLDocument
    doc.Close()
    print(f"已转换: {out.name}")


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    target = Path(sys.argv[1])
    if target.is_file():
        docs = [target]
    elif target.is_dir():
        docs = sorted(target.rglob("*.doc"))
    else:
        sys.exit(f"路径不存在: {target}")
    if not docs:
        sys.exit("未找到 .doc 文件")

    word = win32com.client.Dispatch("Word.Application")
    word.Visible = False
    try:
        for p in docs:
            try:
                convert(p, word)
            except Exception as e:  # 单个失败不中断
                print(f"转换失败 {p.name}: {e}")
    finally:
        word.Quit()


if __name__ == "__main__":
    main()
