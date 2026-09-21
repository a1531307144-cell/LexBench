# -*- coding: utf-8 -*-
"""构建预置法条种子包：从用户法律数据库复制法条 → 清洗文档元数据 → 输出 seed/

用法：python scripts/build-seed.py
- 只收录纯法条/司法解释（对照表、脚本、报告、审查文档一律不收）
- 清洗 docProps：创建者/最后修改者/公司等标识信息一律抹掉（发布包不得含个人信息）
- .doc 老格式暂不收（转换工具不可用）
"""
import io
import os
import re
import shutil
import sys
import zipfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# 源法条库目录：用环境变量指定（本机路径不进公开仓库）
SRC_BASE = os.environ.get('LEXBENCH_LAWDB', '')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, 'seed')

# 分类 → 收录文件名（精确清单，避免误收工作成果）
MANIFEST = {
    '公司法': [
        '中华人民共和国公司法_20231229.docx',
        '国务院关于实施《中华人民共和国公司法》注册资本登记管理制度的规定_20240701.docx',
        '最高人民法院关于《中华人民共和国公司法》第八十八条第一款不溯及适用的批复_20241224.docx',
        '最高人民法院关于适用《中华人民共和国公司法》时间效力的若干规定_20240629.docx',
        '最高人民法院关于适用《中华人民共和国公司法》若干问题的规定（一）_20140220.docx',
        '最高人民法院关于适用《中华人民共和国公司法》若干问题的规定（二）_20201229.docx',
        '最高人民法院关于适用《中华人民共和国公司法》若干问题的规定（三）_20201229.docx',
        '最高人民法院关于适用《中华人民共和国公司法》若干问题的规定（四）_20201229.docx',
        '最高人民法院关于适用《中华人民共和国公司法》若干问题的规定（五）_20201229.docx'
    ],
    '民事诉讼法': [
        '中华人民共和国民事诉讼法_20230901.docx',
        '最高人民法院关于适用《中华人民共和国民事诉讼法》的解释_20220401.docx',
        '最高人民法院关于民事诉讼证据的若干规定_20191225.docx',
        '最高人民法院关于适用《中华人民共和国民事诉讼法》执行程序若干问题的解释_20201229.docx',
        '最高人民法院关于人民法院民事执行中查封、扣押、冻结财产的规定_20201229.docx',
        '最高人民法院关于审理执行异议之诉案件适用法律问题的解释_20250723.docx',
        '最高人民法院关于修改后的民事诉讼法施行时未结案件适用法律若干问题的规定_20121228.docx'
    ],
    '民法典及相关': [
        '中华人民共和国民法典_20200528.docx',
        '最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释_20231204.docx',
        '最高人民法院关于适用《中华人民共和国民法典》婚姻家庭编的解释（一）_20201229.docx',
        '最高人民法院关于适用《中华人民共和国民法典》物权编的解释（一）_20201229.docx',
        '最高人民法院关于审理涉彩礼纠纷案件适用法律若干问题的规定_20240117.docx'
    ],
    '劳动法': [
        '中华人民共和国劳动法_20181229.docx',
        '中华人民共和国劳动合同法_20121228 (1).docx',
        '中华人民共和国劳动争议调解仲裁法_20071229.docx',
        '最高人民法院关于审理劳动争议案件适用法律问题的解释（一）_20201229.docx',
        '最高人民法院关于审理劳动争议案件适用法律问题的解释（二）_20250731.docx'
    ],
    '涉外法律关系适用法': [
        '中华人民共和国涉外民事关系法律适用法_20101028.docx',
        '中华人民共和国海商法_20251028.docx',
        '中华人民共和国民用航空法_20251227.docx',
        '国务院关于涉外知识产权纠纷处理的规定_20250313.docx',
        '最高人民法院关于涉外民商事案件管辖若干问题的规定_20221114.docx',
        '最高人民法院关于涉外民事或商事案件司法文书送达问题若干规定_20201229.docx',
        '最高人民法院关于审理涉外民商事案件适用国际条约和国际惯例若干问题的解释_20231228.docx',
        '最高人民法院关于适用《中华人民共和国涉外民事关系法律适用法》若干问题的解释（一）_20201229.docx',
        '最高人民法院关于适用《中华人民共和国涉外民事关系法律适用法》若干问题的解释（二）_20231130.docx'
    ]
}

# 源文件夹 → 输出分类名的映射（民诉 在源里叫「民诉」）
SRC_FOLDER = {'公司法': '公司法', '民事诉讼法': '民诉', '民法典及相关': '民法典及其相关', '劳动法': '劳动法相关', '涉外法律关系适用法': '涉外法律关系适用法'}

CLEAN_CORE = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    '<cp:coreProperties '
    'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    'xmlns:dc="http://purl.org/dc/elements/1.1/" '
    'xmlns:dcterms="http://purl.org/dc/terms/" '
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    '<dc:creator>LexBench</dc:creator>'
    '<cp:lastModifiedBy>LexBench</cp:lastModifiedBy>'
    '</cp:coreProperties>'
)
CLEAN_APP = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
    '<Application>LexBench</Application>'
    '</Properties>'
)
CLEAN_CUSTOM = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"></Properties>'
)


def sanitize_docx(src: str, dst: str) -> None:
    """复制 docx 并清洗元数据（创建者/最后修改者/公司等）"""
    with zipfile.ZipFile(src) as zin:
        items = [(i, zin.read(i.filename)) for i in zin.infolist()]
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info, data in items:
            name = info.filename
            if name == 'docProps/core.xml':
                data = CLEAN_CORE.encode('utf-8')
            elif name == 'docProps/app.xml':
                data = CLEAN_APP.encode('utf-8')
            elif name == 'docProps/custom.xml':
                data = CLEAN_CUSTOM.encode('utf-8')
            zout.writestr(info, data)


def main() -> None:
    if not SRC_BASE or not os.path.isdir(SRC_BASE):
        raise SystemExit('请用环境变量 LEXBENCH_LAWDB 指定法条库目录')
    if os.path.isdir(DEST):
        shutil.rmtree(DEST)
    total = 0
    for category, files in MANIFEST.items():
        src_dir = os.path.join(SRC_BASE, SRC_FOLDER[category])
        out_dir = os.path.join(DEST, category)
        os.makedirs(out_dir, exist_ok=True)
        for f in files:
            src = os.path.join(src_dir, f)
            if not os.path.isfile(src):
                print(f'  [缺失] {category}/{f}')
                continue
            # 文件名清理：去掉下载重复标记 " (1)"
            clean_name = re.sub(r'\s*\(\d+\)(?=\.\w+$)', '', f)
            dst = os.path.join(out_dir, clean_name)
            sanitize_docx(src, dst)
            # 校验：清洗后不得再出现常见个人信息字段
            with zipfile.ZipFile(dst) as z:
                core = z.read('docProps/core.xml').decode('utf-8')
                app = z.read('docProps/app.xml').decode('utf-8')
            leaked = [k for k in ('YF-INT6', 'Lenovo', 'Administrator', 'yuying', '马儿') if k in core + app]
            if leaked:
                raise SystemExit(f'清洗失败，仍含 {leaked}: {clean_name}')
            total += 1
            print(f'  {category}/{clean_name} ({os.path.getsize(dst) // 1024}KB)')
    print(f'\n种子包完成：{total} 部法条 → {DEST}')


if __name__ == '__main__':
    main()
