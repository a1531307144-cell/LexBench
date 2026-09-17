#!/usr/bin/env python3
"""检查打包产物二进制中是否嵌入构建机的用户名/源码路径。

隐私要求：对外发布的 exe / zip 不得携带作者本机信息。

检测策略：只匹配「路径上下文」（如 C:\\Users\\<name>\\ 及仓库完整路径），
不匹配裸用户名字符串——用户名若为纯数字/常见词，会与词典、pickle 编号等
第三方包数据天然碰撞（jieba word.dic 曾误报：词表序号 15313 恰为用户名）。

用法: python scripts/check_binary_privacy.py <dist目录> <源码仓库路径>
退出码: 0 通过 / 1 发现泄露
"""
import sys
from pathlib import Path


def main(dist_dir: str, repo: str) -> int:
    repo_path = Path(repo).resolve()
    markers = set()
    parts = repo_path.parts  # ('C:\\', 'Users', '<name>', ...)
    if len(parts) > 3 and parts[1].lower() == "users":
        name = parts[2]
        home_ctx = f"users{chr(92)}{name}{chr(92)}"   # users\<name>\
        repo_str = str(repo_path).replace("/", chr(92))
        for base in (home_ctx, repo_str):
            markers.add(base.lower())
            markers.add(base.upper())
    else:
        markers.add(str(repo_path).lower())

    needles = []
    for m in sorted(markers):
        needles.append((m, m.encode("utf-8")))
        needles.append((m + " (utf-16)", m.encode("utf-16-le")))

    hits = []
    for f in Path(dist_dir).rglob("*"):
        if not f.is_file() or f.stat().st_size > 300 * 1024 * 1024:
            continue
        data = f.read_bytes()
        for label, needle in needles:
            if needle in data:
                hits.append((f.name, label))

    if hits:
        for name, label in hits:
            print(f"[泄露] {name} 嵌入了本机路径标记 {label!r}")
        return 1
    print(f"[通过] 打包产物中未发现本机用户名路径（检查标记: {sorted(markers)}）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
