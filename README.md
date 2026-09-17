# LexBench · 法研台

本地优先的个人法律研究工作台 —— 检索、收藏、笔记、AI 辅助，全流程一个界面完成。

## 功能

- **文档导入**：拖拽导入 Word (.docx) / PDF 法律文档，自动按"第X条"切分建库（法规 / 案例 / 其他资料三种类型）
- **双模式检索**：
  - 法条定位 —— 输入 `民法典 1077` 直接跳到《民法典》第一千零七十七条
  - 全文搜索 —— 中文分词 + 关键词高亮 + 上下文摘要
- **研究工作台**（v0.2）：按专题收藏法条、边浏览边记笔记、导出研究报告
- **AI 助手**（v0.3）：法条解释 / 相关案例 / 追问，回答标注引用、可点击核对

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

## 许可

代码采用 [MIT License](LICENSE)。你的法律文档、笔记等数据全部保存在本地 `data/` 目录，不上传、不入库。
