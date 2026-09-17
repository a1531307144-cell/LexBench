# LexBench · 法研台

本地优先的个人法律研究工作台 —— 检索、收藏、笔记、AI 辅助，全流程一个界面完成。

## 功能

- **文档导入**：拖拽导入 Word (.docx) / PDF 法律文档，自动按"第X条"切分建库（法规 / 案例 / 其他资料三种类型）
- **双模式检索**：
  - 法条定位 —— 输入 `民法典 1077` 直接跳到《民法典》第一千零七十七条
  - 全文搜索 —— 中文分词 + 关键词高亮 + 上下文摘要
- **研究工作台**：按专题（如"离婚财产分割"）★ 收藏法条，专题内逐条浏览，右栏 Markdown 笔记（可关联具体法条），一键导出 Markdown / Word 研究报告
- **条文修正**：解析有误的条文可直接在阅读器内修正，全文索引同步更新
- **AI 研究助手**：接入任意 OpenAI 兼容接口（DeepSeek / 通义 / Kimi 等），在法条页一键「解读本条」「找案例」或自由追问；回答中的《法规名》第X条引用可点击跳转核对；问答按条文存档本机

## AI 使用说明

1. 点击右上角「AI 设置」，填入 OpenAI 兼容接口地址（如 `https://api.deepseek.com/v1`）、模型名与 API Key，点「测试连接」验证
2. 打开任意法条，在正文下方「AI 研究助手」面板使用三个功能
3. 你的 API Key 只保存在本机 `data/` 目录的数据库中，不会上传 GitHub、不写入任何日志；AI 调用也只发生在你配置之后

## 快速开始

前置要求：Windows + Python 3.11+（无需 Node.js，前端已预构建）

```
1. 双击 start.bat（首次运行自动创建虚拟环境并安装依赖）
2. 浏览器自动打开 http://127.0.0.1:8788
```

## 开发

```
backend:  cd backend && pip install -r requirements.txt && pytest
frontend: cd frontend && npm install && npm run dev
```

详细设计见 [docs/plans/2026-09-17-lexbench-design.md](docs/plans/2026-09-17-lexbench-design.md)。

## 发布流程（维护者）

对外发布（push / 打 tag / Release）前必须走 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) 审批：

```
python scripts/security_check.py --history --strict   # 第一关：自动扫描隐私与密钥
人工复核 RELEASE_CHECKLIST.md 清单                     # 第二关：逐项确认
```

CI 会在每次推送时自动复检测试与安全扫描，本地漏掉的会被拦截。

## 许可

代码采用 [MIT License](LICENSE)。你的法律文档、笔记等数据全部保存在本地 `data/` 目录，不上传、不入库。
