# 发版流程（2026-11-12 起）

目标：**安全底线一项不少，重复劳动一项不做**。

## 0. 铁律

- 未经用户明确同意（dev 试用通过）不得 tag / 发 Release。
- 只递增小版本号（`0.9.13 → 0.9.14`），除非用户明确要求。
- 隐私扫描、单测、类型检查、构建、数据路径复核——这五项是底线，不因「改动小」而跳过。

## 0.1 开发迭代期 vs 发版前（2026-11-12 用户明确要求）

用户要求：**不要每次小改动都自测一遍；安全性和验证集中在正式发布之前做一次。**

| 阶段 | 要做的事 | 不要做的事 |
|---|---|---|
| 开发迭代期（一个小版本内可能有多次改动） | 改完直接交用户 dev 试用，听反馈继续改 | 不跑全量闸门、不跑 CDP 自测、不做独立复核 |
| 用户报 bug / 怀疑没生效 | 只针对该问题做一次最小复现（必要时探针确认新代码已加载） | 不顺手把所有套件跑一遍 |
| 正式发布前 | `npm run preflight` + 按风险分级跑 CDP 自测 + 定向复核 | 不要跳过（这是唯一的集中验证点） |

**为什么**：小改动反复全量自测消耗时间与 token，而且改动还没定稿时跑的结论随时作废；
真正的把关点是"这一版要发出去之前"。

**例外（必须做，但成本很低）**：改主进程后确认新代码真的生效（见踩坑 #6），
否则后面的手工试用全是在测旧代码。

## 1. 一条命令完成预检

```bash
npm run preflight            # 静态检查 + 风险分级 + 机械闸门
npm run preflight -- --no-gate   # 只看版本一致性与该跑哪几套自测
```

预检会回答：

1. `package.json` / `CHANGELOG.md` / `RELEASE_NOTES.md` 三处版本是否一致；
2. 本地或远端是否**已经存在**同版本标签（防重复发布）；
3. 本次改动的风险等级与建议的 CDP 自测套件；
4. `tsc` / `vitest` / `build` / `privacy-check` 是否全绿。

## 2. 风险分级

| 等级 | 判定（只看 `src/` 改动） | CDP 自测 | 发布前复核 |
|---|---|---|---|
| 低 | 仅渲染层组件 / 样式 / 文案 | `selftest-core` + 受影响套 | 跳过 |
| 中 | 动了主进程 / preload / shared / composables | `core` + `notes` + 受影响套 | 一次定向复核 |
| 高 | 数据持久化 / 迁移 / 保存链 / 多窗并发 / 启动流程，或改动 > 25 个文件 | 全部 9 套 | 定向复核 + dev 实测重点项 |

定向复核只喂 `git diff <上个标签>..HEAD`，固定看这几类：

- 保存 / 冲刷时序（`save` 与 `get` 的先后、卸载钩子、防抖窗口）
- 迁移与 `ON DELETE CASCADE`
- 多窗并发写（阅读进度 / 缩放）
- IPC 顺序与异常路径
- 隐私：有没有把本机数据、路径、真实信息带进仓库

## 3. 发布说明：单一来源

**`RELEASE_NOTES.md`（仓库根）是发布说明的唯一来源。**

- 每版手写一次，版本号 `vX.Y.Z` 写在文件里；
- `release.yml` 用 `--notes-file RELEASE_NOTES.md` 发布，并校验版本号匹配；
- 不要再往 `.github/workflows/release.yml` 里塞正文。

`CHANGELOG.md` 仍然保留给仓库读者（Keep a Changelog 格式），但它不是线上 Release 的来源。

## 4. 隐私闸门

`node scripts/privacy-check.mjs` 扫三层：

1. **文件内容**：手机号 / 邮箱 / 密钥 / base64 图片 / 本机绝对路径 / 本机专属敏感词；
2. **路径与文件名**：同一套规则（防止真实姓名只出现在文件名里）；
3. **未登记文件类型**：`.docx` / `.pdf` / 图片 / 压缩包等，除 `seed/`、`docs/screenshots/`、`build/` 外一律报警。

本机专属敏感词放在**不提交**的 `scripts/.privacy-terms`；CI 只能跑通用规则，所以**本机这一跑不可省**。

## 5. 手工步骤（预检通过后）

```bash
git add -A && git commit -m "release: vX.Y.Z——…"
git push origin main
gh run watch                      # 等 CI 绿
git tag vX.Y.Z && git push origin vX.Y.Z
gh run watch
gh release view vX.Y.Z            # 核对 exe / blockmap / latest.yml / SHA256SUMS，且为 Latest
```

## 6. 不要做的事

- 不要为了省事跳过 `privacy-check`（它是唯一能挡住真实姓名外泄的闸门）。
- 不要在低风险版本上做多代理全库复核——成本高、收益低。
- 不要凭记忆发版：先跑 `npm run preflight`。
