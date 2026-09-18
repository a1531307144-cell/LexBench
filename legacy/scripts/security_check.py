#!/usr/bin/env python3
"""LexBench 发布前安全与隐私扫描 —— 发布审批流程的自动关卡。

用法:
    python scripts/security_check.py             # 扫描工作区（已跟踪 + 未忽略的未跟踪文件）
    python scripts/security_check.py --history   # 同时扫描全部 git 提交历史
    python scripts/security_check.py --strict    # 警告也视为失败（对外发布前使用）

退出码: 0 通过 / 1 未通过。仅依赖 Python 标准库与 git。
新增合法样例（测试夹具等）造成误报时，在下方配置区的白名单中登记。
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# ---------- 配置区 ----------

# 通用用户名/路径占位符，命中这些不算泄露
GENERIC_USERS = {
    "username", "user", "yourname", "your_name", "your-name", "your_username",
    "administrator", "admin", "default", "public", "shared", "test", "demo", "app",
}

# 凭据值的占位词，含这些词的赋值视为示例而非真实密钥
PLACEHOLDER_HINTS = (
    "your", "example", "sample", "dummy", "fake", "placeholder", "xxx",
    "todo", "changeme", "change-me", "replace", "<", "test",
)

# 允许入库的文件前缀（如合成的测试夹具）
ALLOWED_FILE_PREFIXES = ("tests/fixtures/",)

# 已确认无风险的邮箱（GitHub 匿名提交邮箱等）
ALLOWED_EMAIL_SUBSTRINGS = ("noreply", "example.com", "@localhost")

# 大文件阈值：入库文件超过该大小提示人工确认
LARGE_FILE_BYTES = 5 * 1024 * 1024

# ---------- 检测规则 ----------

# (正则, 级别, 说明, 取值分组, 检查方式)
#   取值分组: 用第 N 组做白名单判断（0 = 整个匹配）; 检查方式: secret/path/plain/email
PATTERNS = [
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "error", "私钥内容", 0, "plain"),
    (r"\bghp_[A-Za-z0-9]{36}\b", "error", "GitHub 个人访问令牌", 0, "plain"),
    (r"\bgho_[A-Za-z0-9]{36}\b", "error", "GitHub OAuth 令牌", 0, "plain"),
    (r"\bgithub_pat_[A-Za-z0-9_]{22,}\b", "error", "GitHub 细粒度令牌", 0, "plain"),
    (r"\bsk-ant-[A-Za-z0-9_\-]{20,}\b", "error", "Anthropic API key", 0, "plain"),
    (r"\bsk-[A-Za-z0-9_\-]{20,}\b", "error", "OpenAI 风格 API key", 0, "plain"),
    (r"\bxox[bap]-[A-Za-z0-9\-]{10,}\b", "error", "Slack 令牌", 0, "plain"),
    (r"\bAKIA[0-9A-Z]{16}\b", "error", "AWS Access Key ID", 0, "plain"),
    (r"\bAIza[0-9A-Za-z_\-]{35}\b", "error", "Google API key", 0, "plain"),
    (r"\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\b", "error", "JWT 令牌", 0, "plain"),
    (r"\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?token|auth[_-]?token|"
     r"client[_-]?secret|password|passwd|pwd|token)\b\s*[:=]\s*[\"']([^\"']{6,})[\"']",
     "error", "疑似硬编码凭据赋值", 2, "secret"),
    (r"[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s\"':,<>|]+)", "error", "含用户名的 Windows 本机路径", 1, "path"),
    (r"/home/([a-zA-Z0-9._-]+)", "error", "含用户名的 Linux 本机路径", 1, "path"),
    (r"/Users/([a-zA-Z0-9._-]+)", "error", "含用户名的 macOS 本机路径", 1, "path"),
    (r"\b1[3-9]\d{9}\b", "warn", "疑似手机号", 0, "plain"),
    (r"\b\d{17}[0-9Xx]\b", "warn", "疑似身份证号", 0, "plain"),
    (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "warn", "邮箱地址", 0, "email"),
]

COMPILED = [(re.compile(p), lvl, desc, gi, kind) for p, lvl, desc, gi, kind in PATTERNS]

FORBIDDEN_FILE_RULES = [
    (re.compile(r"^data/"), "用户数据目录（法律文档 + 数据库）"),
    (re.compile(r"\.(db|sqlite3?|pem|key|p12|pfx|crt|env)$", re.IGNORECASE), "敏感文件（数据库/密钥/环境变量）"),
    (re.compile(r"^id_rsa", re.IGNORECASE), "SSH 私钥"),
    (re.compile(r"\.(docx?|pdf)$", re.IGNORECASE), "文档文件（法律内容有版权与隐私风险）"),
]

REQUIRED_GITIGNORE_ENTRIES = ("data/", ".env")


def git(*args: str) -> str:
    p = subprocess.run(["git", *args], cwd=REPO, capture_output=True)
    if p.returncode != 0:
        msg = p.stderr.decode("utf-8", errors="replace").strip()
        raise SystemExit(f"[失败] git {' '.join(args)} 执行出错:\n  {msg}")
    return p.stdout.decode("utf-8", errors="replace")


def _is_placeholder(value: str) -> bool:
    v = value.lower()
    return any(h in v for h in PLACEHOLDER_HINTS)


def _allowed(value: str, kind: str) -> bool:
    if kind == "secret":
        return _is_placeholder(value)
    if kind == "path":
        return value.lower() in GENERIC_USERS
    if kind == "email":
        return any(s in value.lower() for s in ALLOWED_EMAIL_SUBSTRINGS)
    return False


def scan_line(line: str):
    """返回 [(级别, 说明, 命中片段)]，同一位置的重复命中只报一次。"""
    found, spans = [], []
    for regex, lvl, desc, gi, kind in COMPILED:
        for m in regex.finditer(line):
            if any(s <= m.start() < e or s < m.end() <= e for s, e in spans):
                continue
            value = m.group(gi) if gi <= (m.re.groups) else m.group(0)
            if kind != "plain" and _allowed(value, kind):
                continue
            spans.append((m.start(), m.end()))
            excerpt = m.group(0)
            if len(excerpt) > 60:
                excerpt = excerpt[:57] + "..."
            found.append((lvl, desc, excerpt))
    return found


def is_text_file(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            return b"\x00" not in f.read(65536)
    except OSError:
        return False


def tracked_files() -> list[str]:
    return [f for f in git("ls-files").splitlines() if f.strip()]


def untracked_files() -> list[str]:
    out = git("ls-files", "--others", "--exclude-standard")
    return [f for f in out.splitlines() if f.strip()]


def check_forbidden_paths(files: list[str]) -> list[tuple[str, str, str]]:
    hits = []
    for f in files:
        norm = f.replace("\\", "/")
        if any(norm.startswith(p) for p in ALLOWED_FILE_PREFIXES):
            continue
        for rule, desc in FORBIDDEN_FILE_RULES:
            if rule.search(norm):
                hits.append(("error", f, f"禁止入库的文件类型: {desc}"))
                break
    return hits


def check_gitignore() -> list[tuple[str, str, str]]:
    results = []
    try:
        text = (REPO / ".gitignore").read_text(encoding="utf-8")
    except OSError:
        return [("error", ".gitignore", "缺少 .gitignore 文件")]
    for entry in REQUIRED_GITIGNORE_ENTRIES:
        if entry not in text:
            results.append(("error", ".gitignore", f"缺少必要排除项: {entry}"))
    probe = REPO / "data" / "lexbench.db"
    if probe.exists():
        p = subprocess.run(["git", "check-ignore", "-q", "data/lexbench.db"],
                           cwd=REPO, capture_output=True)
        if p.returncode != 0:
            results.append(("error", "data/", "数据库文件未被 git 忽略，将被入库！"))
    return results


def scan_file(path_str: str, origin: str) -> list[tuple[str, str, str]]:
    path = REPO / path_str
    if not path.is_file() or not is_text_file(path):
        return []
    hits = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    for i, line in enumerate(text.splitlines(), 1):
        for lvl, desc, excerpt in scan_line(line):
            loc = f"{path_str}:{i}" + ("" if origin == "tracked" else " (未跟踪)")
            hits.append((lvl, loc, f"{desc}: {excerpt}"))
    return hits


def scan_working_tree() -> list[tuple[str, str, str]]:
    hits = []
    for f in tracked_files():
        hits += scan_file(f, "tracked")
    for f in untracked_files():
        hits += scan_file(f, "untracked")
    return hits


def check_large_files(files: list[str]) -> list[tuple[str, str, str]]:
    hits = []
    for f in files:
        p = REPO / f
        try:
            size = p.stat().st_size
        except OSError:
            continue
        if size > LARGE_FILE_BYTES:
            hits.append(("warn", f, f"大文件 {size // 1024 // 1024}MB，请确认为程序资源而非用户数据"))
    return hits


def scan_history() -> list[tuple[str, str, str]]:
    """扫描全部提交历史：曾出现过的文件名与内容差异。"""
    hits = []
    seen_paths = set()
    for line in git("log", "--all", "--name-only", "--pretty=format:").splitlines():
        f = line.strip()
        if f and f not in seen_paths:
            seen_paths.add(f)
    for lvl, path, desc in check_forbidden_paths(sorted(seen_paths)):
        hits.append((lvl, f"历史提交: {path}", desc))

    commit, file_ctx = "?", "?"
    for line in git("log", "--all", "-p").splitlines():
        if line.startswith("commit "):
            commit = line.split()[1][:7]
        elif line.startswith("diff --git a/"):
            file_ctx = line.split(" b/")[-1]
        # 剥掉 diff 行标记（+/-/空格），避免 pytest 装饰器行被误判为邮箱
        content = line[1:] if line[:1] in "+- " else line
        for lvl, desc, excerpt in scan_line(content):
            hits.append((lvl, f"历史 {commit} · {file_ctx}", f"{desc}: {excerpt}"))
    return hits


def main():
    parser = argparse.ArgumentParser(description="LexBench 发布前安全与隐私扫描")
    parser.add_argument("--history", action="store_true", help="同时扫描全部 git 提交历史")
    parser.add_argument("--strict", action="store_true", help="警告也视为失败")
    args = parser.parse_args()

    print("==== LexBench 发布前安全与隐私扫描 ====")
    all_hits = []
    all_hits += check_gitignore()
    tracked = tracked_files()
    all_hits += check_forbidden_paths(tracked)
    all_hits += check_large_files(tracked)
    all_hits += scan_working_tree()
    if args.history:
        all_hits += scan_history()

    if not all_hits:
        print("[通过] 未发现隐私或安全问题")
        return 0

    errors = [h for h in all_hits if h[0] == "error"]
    warns = [h for h in all_hits if h[0] == "warn"]
    for lvl, loc, msg in errors:
        print(f"[错误] {loc} — {msg}")
    for lvl, loc, msg in warns:
        print(f"[警告] {loc} — {msg}")

    print(f"\n汇总: {len(errors)} 错误, {len(warns)} 警告")
    failed = errors or (args.strict and warns)
    if failed:
        print("结论: [未通过] 修复上述问题后重新扫描; 误报可在 scripts/security_check.py 白名单登记")
        return 1
    print("结论: [有条件通过] 无错误; 警告项需在 docs/RELEASE_CHECKLIST.md 人工复核中逐条确认")
    return 0


if __name__ == "__main__":
    sys.exit(main())
