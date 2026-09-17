"""README 截图维护脚本：Playwright 驱动系统 Edge（无头）截三张界面图。

用法（维护者更新截图时）：
    # 1. 用干净的临时数据目录启动服务
    #    PowerShell: $env:LEXBENCH_DATA_DIR="$env:TEMP\lexbench-shots";
    #                .venv\Scripts\python.exe -m uvicorn app.main:app --port 8799 --app-dir backend
    # 2. 运行本脚本（会自动导入 samples/ 示例并准备演示用专题与笔记）
    .venv\Scripts\python.exe scripts\take_screenshots.py

依赖：pip install playwright（仅本机维护用，不进 requirements.txt；
浏览器用系统自带 Edge，无需额外下载）。
"""
import glob
import os
from pathlib import Path

import httpx
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8799"
REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "docs" / "screenshots"


def setup_demo_data():
    """空库时导入 samples/ 并准备演示专题（已有数据则跳过，幂等）。"""
    if httpx.get(BASE + "/api/documents").json():
        return
    files = [
        ("files", (os.path.basename(p), open(p, "rb").read(), "text/plain"))
        for p in glob.glob(str(REPO / "samples" / "*.txt"))
    ]
    httpx.post(BASE + "/api/documents", files=files)
    tid = httpx.post(
        BASE + "/api/topics", json={"name": "离婚纠纷研究", "description": "冷静期与财产分割相关条文"}
    ).json()["id"]
    for no in (1062, 1077, 1084, 1087):
        aid = httpx.get(BASE + "/api/search", params={"q": f"民法典 {no}"}).json()["results"][0]["id"]
        httpx.post(BASE + f"/api/topics/{tid}/items", json={"article_id": aid})
    aid1077 = httpx.get(BASE + "/api/search", params={"q": "民法典 1077"}).json()["results"][0]["id"]
    httpx.post(
        BASE + "/api/notes",
        json={
            "topic_id": tid,
            "article_id": aid1077,
            "content_md": "**要点**：冷静期 30 日，自婚姻登记机关**收到申请**之日起算；届满后 30 日内未申请发证的，视为撤回。",
        },
    )
    httpx.post(
        BASE + "/api/notes",
        json={
            "topic_id": tid,
            "article_id": None,
            "content_md": "研究思路：先梳理协议离婚（1076-1078）与诉讼离婚（1079）的分界，再看财产分割规则。",
        },
    )


def shot1(page):
    """法条定位 + AI 面板。"""
    page.goto(BASE, wait_until="networkidle")
    page.fill(".search-input", "民法典 1077")
    page.press(".search-input", "Enter")
    page.wait_for_selector(".article-label")
    page.wait_for_selector(".ai-panel .ai-btn")
    page.wait_for_timeout(400)
    page.evaluate("document.querySelector('.reader-pane').scrollTop = 40")
    page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / "01-locate.png"))
    print("01-locate.png ok")


def shot2(page):
    """全文检索 + 关键词高亮。"""
    page.fill(".search-input", "离婚 冷静期")
    page.press(".search-input", "Enter")
    page.wait_for_selector(".result-list em", timeout=5000)
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / "02-fulltext.png"))
    print("02-fulltext.png ok")


def shot3(page):
    """研究工作台三栏联动。"""
    page.get_by_role("button", name="专题").click()
    page.get_by_text("离婚纠纷研究").first.click()
    page.wait_for_selector(".notes-pane")
    page.locator(".item-label:visible", has_text="第一千零七十七条").first.click()
    page.wait_for_selector(".article-label")
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "03-workbench.png"))
    print("03-workbench.png ok")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    setup_demo_data()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        try:
            shot1(page)
            shot2(page)
            shot3(page)
        finally:
            browser.close()
    for f in sorted(OUT.glob("*.png")):
        print(f.name, f.stat().st_size)
