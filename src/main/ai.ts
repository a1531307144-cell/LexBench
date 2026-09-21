// AI 研究助手：模型档案（多档案可切换，密钥只存本机）+ 流式问答（解读本条 / 找案例 / 追问）
// 移植自 legacy/backend/app/routers/ai.py + services/ai_provider.py + services/retriever.py：
//   - 密钥只存 ai_profiles 表（本机 DB，随数据包走），回传界面一律只给掩码；
//   - 配置解析顺序「显式值 → 指定档案 → 当前启用档案」（test / run 共用同一条回退链）；
//   - 上下文只喂用户本地文档库（RAG，renderContext 预算 1800）：本条 + 同文档相邻 ±2 条 +
//     FTS 相关法规 3 条（找案例时另加 doc_type='case' 的命中段落 3 条，标签统一「相关段落」）；
//   - 流式增量经 ai:progress 推给发起者（ipcMain.handle 的 event.sender），支持 ai:cancel 中止；
//   - 错误一律 throw new Error('中文') 或经 ai:progress 的 error 字段回传（流已开始时不再抛）

import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { AiProfilePatch, AiProgress, AiRunRequest } from '../shared/ipc'
import type { AiCitation, AiMessageRow, AiProfileRow, AiProtocol, AiTask } from '../shared/types'
import {
  chatUrl,
  authHeaders,
  buildBody,
  pickReply,
  parseSseLine,
  endpointHint,
  type ChatMessage
} from '@shared/aiProtocol'
import {
  HISTORY_LIMIT,
  SYSTEM_PROMPT,
  buildCasesPrompt,
  buildExplainPrompt,
  buildFollowupMessages,
  parseCitations,
  renderContext
} from '@shared/aiPrompts'
import type { AiArticleBrief, AiContextItem, AiHistoryMessage } from '@shared/aiPrompts'
import { cn2num } from '@shared/cnnum'
import { matchDocumentIds } from '@shared/locate'
import { queryTokens } from '@shared/tokenize'
import { getDb, initDb } from './db'

// ---------- 常量 ----------

/** 「测试连接」超时（毫秒）；正式问答是流式长回答，不设超时（只受 ai:cancel 控制） */
const TEST_TIMEOUT_MS = 30_000
/** 相邻条文跨度：同文档 order_index ±2（不含自身） */
const NEIGHBOR_SPAN = 2
/** 相关法规条文 / 案例段落各取前 N 条 */
const RELATED_LIMIT = 3
/** 送 FTS 的分词上限（与 legacy retriever 一致） */
const MATCH_TOKEN_LIMIT = 8
/** 模型配置缺项时的统一提示（test 与 run 未配置共用一个判断） */
const NOT_CONFIGURED_REPLY = '请先填写接口地址、模型与 API Key'
const NOT_CONFIGURED_RUN = '尚未配置 AI 接口，请先在「AI 设置」中填写'
/** HTTP 错误正文 / 测试回复的截断长度 */
const ERROR_BODY_CLIP = 200
const TEST_REPLY_CLIP = 50
/** 历史里 explain / cases 的空 question 代填文案（对应 legacy _history_messages） */
const DEFAULT_QUESTION: Record<string, string> = {
  explain: '请解释这条法条',
  cases: '请找相关案例'
}

// ---------- 行映射（node:sqlite 的整型可能以 bigint 到达，统一 Number() 收窄） ----------

/** node:sqlite 原始行：字段值一律 unknown，经转换函数收窄成 shared 类型 */
type DbRow = Record<string, unknown>

/** 掩码：长度 >8 取「前 3 + **** + 后 3」，否则整体 ****；空密钥返回空串 */
function maskKey(key: string): string {
  if (!key) return ''
  return key.length > 8 ? `${key.slice(0, 3)}****${key.slice(-3)}` : '****'
}

/** 协议白名单归一：未知值一律按 OpenAI 兼容处理 */
function normalizeProtocol(v: unknown): AiProtocol {
  return v === 'anthropic' ? 'anthropic' : 'openai'
}

/** 行 → AiProfileRow：密钥只以掩码出主进程（明文绝不回渲染层） */
function toProfileRow(row: DbRow): AiProfileRow {
  const key = String(row['api_key'] ?? '')
  return {
    id: Number(row['id']),
    name: String(row['name']),
    base_url: String(row['base_url'] ?? ''),
    model: String(row['model'] ?? ''),
    protocol: normalizeProtocol(row['protocol']),
    is_active: Number(row['is_active']) ? 1 : 0,
    created_at: String(row['created_at']),
    api_key_masked: maskKey(key),
    api_key_set: key.length > 0
  }
}

/** 行 → AiMessageRow：article_id / topic_id 可空（专题级问答无关联条文） */
function toMessageRow(row: DbRow): AiMessageRow {
  return {
    id: Number(row['id']),
    article_id: row['article_id'] == null ? null : Number(row['article_id']),
    topic_id: row['topic_id'] == null ? null : Number(row['topic_id']),
    action: String(row['action']) as AiTask,
    question: String(row['question'] ?? ''),
    answer_md: String(row['answer_md'] ?? ''),
    citations: String(row['citations'] ?? '[]'),
    created_at: String(row['created_at'])
  }
}

// ---------- 档案读取与配置解析 ----------

/** 按 id 取档案原始行（含明文密钥，仅供主进程内部使用） */
function getProfileRow(db: DatabaseSync, id: number): DbRow | undefined {
  return db.prepare('SELECT * FROM ai_profiles WHERE id=?').get(id) as DbRow | undefined
}

/** 当前启用档案（至多一条；未启用任何档案时返回 undefined） */
function getActiveProfileRow(db: DatabaseSync): DbRow | undefined {
  return db.prepare('SELECT * FROM ai_profiles WHERE is_active=1 ORDER BY id LIMIT 1').get() as
    | DbRow
    | undefined
}

/** 一次调用真正用到的配置（已 trim，去掉了「选哪份档案」的过程） */
interface ResolvedConfig {
  baseUrl: string
  model: string
  apiKey: string
  protocol: AiProtocol
}

/** 显式配置（测试连接可传未保存的表单；空串/缺省一律视为未提供） */
interface AiProbe {
  id?: number
  baseUrl?: string
  model?: string
  protocol?: AiProtocol
  apiKey?: string
}

/**
 * 配置解析：逐字段回退「probe 显式值 → 该 id 档案 → 当前启用档案」。
 * apiKey 留空 = 用已存密钥（对应界面上「不填即不修改」的习惯）。
 */
function resolveConfig(db: DatabaseSync, probe: AiProbe): ResolvedConfig {
  const scoped =
    probe.id == null || !Number.isFinite(Number(probe.id))
      ? undefined
      : getProfileRow(db, Number(probe.id))
  const active = getActiveProfileRow(db)
  const pick = (explicit: string | undefined, field: keyof ResolvedConfig): string => {
    if (field === 'baseUrl') {
      const e = String(explicit ?? '').trim()
      if (e) return e
      return String(scoped?.['base_url'] ?? '').trim() || String(active?.['base_url'] ?? '').trim()
    }
    if (field === 'model') {
      const e = String(explicit ?? '').trim()
      if (e) return e
      return String(scoped?.['model'] ?? '').trim() || String(active?.['model'] ?? '').trim()
    }
    const e = String(explicit ?? '').trim()
    if (e) return e
    return String(scoped?.['api_key'] ?? '').trim() || String(active?.['api_key'] ?? '').trim()
  }
  const protocol: AiProtocol =
    probe.protocol ??
    (scoped?.['protocol'] !== undefined
      ? normalizeProtocol(scoped['protocol'])
      : active?.['protocol'] !== undefined
        ? normalizeProtocol(active['protocol'])
        : 'openai')
  return {
    baseUrl: pick(probe.baseUrl, 'baseUrl'),
    model: pick(probe.model, 'model'),
    apiKey: pick(probe.apiKey, 'apiKey'),
    protocol
  }
}

/** 三项齐备才算配置完成（与 legacy is_configured 同义） */
function isConfigured(cfg: ResolvedConfig): boolean {
  return Boolean(cfg.baseUrl && cfg.model && cfg.apiKey)
}

// ---------- HTTP（OpenAI 兼容协议） ----------

// 请求地址 / 请求头 / 请求体 / 取文 / SSE 解析已抽到 @shared/aiProtocol.ts：
// 两套协议走同一入口，纯函数层可被 vitest 直接覆盖（主进程代码此前是测试盲区）

/** 网络异常原因：取消（正常中止）与超时给中文说明，其余取原始 message */
function networkReason(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return '请求超时（30 秒）'
  return err instanceof Error ? err.message : String(err)
}

/** 非 200 响应统一转中文错误（401 单独提示密钥问题） */
async function httpError(res: Response): Promise<Error> {
  if (res.status === 401) return new Error('接口认证失败（401）：请检查 API Key 是否正确')
  const text = await res.text().catch(() => '')
  // 两套协议的错误体都是 {"error":{"message":"…"}}：优先只透出那句话，别把整坨 JSON 糊给用户
  let detail = ''
  try {
    detail = embeddedError(JSON.parse(text)) ?? ''
  } catch {
    detail = ''
  }
  return new Error(`接口返回 ${res.status}：${(detail || text).slice(0, ERROR_BODY_CLIP)}`)
}

/**
 * 从 200 响应体里提取内嵌错误信息。
 * 部分兼容网关失败时仍回 200，把错误放在体内（如 {"code":500,"msg":"404 NOT_FOUND"} 或
 * {"error":{"code":"1001","message":"…"}}）——这类情况要把体内的原因透给用户。
 */
function embeddedError(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const d = data as { msg?: unknown; message?: unknown; code?: unknown; success?: unknown; error?: unknown }
  if (d.error && typeof d.error === 'object') {
    const e = d.error as { message?: unknown }
    if (typeof e.message === 'string' && e.message) return e.message
  }
  const text = typeof d.msg === 'string' ? d.msg : typeof d.message === 'string' ? d.message : ''
  const flagged =
    d.success === false ||
    (typeof d.code === 'number' && d.code !== 0) ||
    (typeof d.code === 'string' && d.code !== '0' && d.code !== '')
  return flagged && text ? text : null
}

/** 测试连接：非流式 POST，30 秒超时；一切失败都以 {ok:false,error} 返回（不抛） */
async function probeConnection(cfg: ResolvedConfig): Promise<{ ok: boolean; error?: string; reply?: string }> {
  if (!isConfigured(cfg)) return { ok: false, error: NOT_CONFIGURED_REPLY }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    const res = await fetch(chatUrl(cfg.protocol, cfg.baseUrl), {
      method: 'POST',
      headers: authHeaders(cfg.protocol, cfg.apiKey),
      body: JSON.stringify(
        buildBody(cfg.protocol, cfg.model, [{ role: 'user', content: '请回复：连接正常' }], false)
      ),
      signal: controller.signal
    })
    if (!res.ok) return { ok: false, error: (await httpError(res)).message }
    const text = await res.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return { ok: false, error: '接口响应格式异常：返回内容不是合法 JSON' }
    }
    const reply = pickReply(cfg.protocol, data)
    if (reply === null) {
      // 有些网关会用「HTTP 200 + 错误体」表达失败（如协议选错时回 {"code":500,"msg":"404 NOT_FOUND"}），
      // 此时报「格式异常」会让人一头雾水——直接把体内错误抛出来，并按当前协议给出正确样例
      const embedded = embeddedError(data)
      if (embedded) {
        return { ok: false, error: `接口返回：${embedded}（${endpointHint(cfg.protocol)}）` }
      }
      return { ok: false, error: `接口响应格式异常：未取到回答内容（${endpointHint(cfg.protocol)}）` }
    }
    return { ok: true, reply: reply.trim().slice(0, TEST_REPLY_CLIP) }
  } catch (err) {
    return { ok: false, error: `网络请求失败：${networkReason(err)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 流式任务状态：controller 供 ai:cancel 中止；canceled 区分「用户取消」与「真异常」 */
interface TaskState {
  controller: AbortController
  canceled: boolean
}

/** 流式对话：逐行解析 SSE，增量经 onDelta 回传，返回完整回答文本 */
async function streamChat(
  cfg: ResolvedConfig,
  messages: ChatMessage[],
  state: TaskState,
  onDelta: (delta: string) => void
): Promise<string> {
  const res = await fetch(chatUrl(cfg.protocol, cfg.baseUrl), {
    method: 'POST',
    headers: authHeaders(cfg.protocol, cfg.apiKey),
    body: JSON.stringify(buildBody(cfg.protocol, cfg.model, messages, true)),
    signal: state.controller.signal
  })
  if (!res.ok) throw await httpError(res)
  if (!res.body) throw new Error('接口响应异常：没有返回内容')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let at = buffer.indexOf('\n')
    while (at >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '')
      buffer = buffer.slice(at + 1)
      const parsed = parseSseLine(cfg.protocol, line)
      if (parsed.kind === 'done') return answer
      if (parsed.kind === 'error') throw new Error(`接口返回：${parsed.message}`)
      if (parsed.kind === 'delta') {
        answer += parsed.text
        onDelta(parsed.text)
      }
      at = buffer.indexOf('\n')
    }
  }
  // 流结束时缓冲区可能还剩最后一行（无尾随换行的实现）：按同一规则再解一次，避免丢尾段
  const tail = buffer.replace(/\r$/, '')
  if (tail.trim()) {
    const parsed = parseSseLine(cfg.protocol, tail)
    if (parsed.kind === 'delta') {
      answer += parsed.text
      onDelta(parsed.text)
    }
    if (parsed.kind === 'error') throw new Error(`接口返回：${parsed.message}`)
  }
  if (!answer.trim()) {
    // 一个增量都没收到：多半是「200 + 错误体」（协议选错 / 端点填错）——
    // 把体内的原因解析出来，别让用户面对一个空回答
    let embedded: string | null = null
    try {
      embedded = embeddedError(JSON.parse(buffer.trim() || 'null'))
    } catch {
      embedded = null
    }
    if (embedded) {
      throw new Error(`接口返回：${embedded}（${endpointHint(cfg.protocol)}）`)
    }
    throw new Error('接口没有返回任何内容，请检查接口地址与模型名是否正确')
  }
  return answer
}

// ---------- 本地 RAG 上下文 ----------

/** 组装上下文的条文行（JOIN 出法规名，供《法规名》第X条 渲染） */
interface ArticleContextRow {
  id: number
  document_id: number
  order_index: number
  title: string
  label: string
  content: string
}

/** 取条文（含所属法规名）；不存在返回 null */
function loadArticle(db: DatabaseSync, articleId: number): ArticleContextRow | null {
  const row = db
    .prepare(
      'SELECT a.id, a.document_id, a.article_label, a.content, a.order_index, d.title' +
        ' FROM articles a JOIN documents d ON d.id = a.document_id WHERE a.id=?'
    )
    .get(articleId) as DbRow | undefined
  if (!row) return null
  return {
    id: Number(row['id']),
    document_id: Number(row['document_id']),
    order_index: Number(row['order_index']),
    title: String(row['title']),
    label: String(row['article_label']),
    content: String(row['content'])
  }
}

/** 条文行 → 提示词用的条文摘要 */
function toBrief(a: ArticleContextRow): AiArticleBrief {
  return { title: a.title, label: a.label, content: a.content }
}

/** 查询分词：本条正文切词后取前若干个（FTS OR 匹配用） */
function matchTokens(content: string): string[] {
  return queryTokens(content).slice(0, MATCH_TOKEN_LIMIT)
}

/** 相邻条文：同文档 order_index ±2 且不含自身，按 order_index 升序 */
function neighborItems(db: DatabaseSync, a: ArticleContextRow): AiContextItem[] {
  const rows = db
    .prepare(
      'SELECT a.article_label, a.content, d.title FROM articles a' +
        ' JOIN documents d ON d.id = a.document_id' +
        ' WHERE a.document_id=? AND a.order_index BETWEEN ? AND ? AND a.id<>?' +
        ' ORDER BY a.order_index'
    )
    .all(a.document_id, a.order_index - NEIGHBOR_SPAN, a.order_index + NEIGHBOR_SPAN, a.id) as unknown as DbRow[]
  return rows.map((r) => ({
    title: String(r['title']),
    label: String(r['article_label']),
    content: String(r['content'])
  }))
}

/** 相关法规条文：本条正文分词走 articles_fts（token 加双引号安全包裹），排除同文档 */
function relatedStatuteItems(db: DatabaseSync, a: ArticleContextRow): AiContextItem[] {
  const tokens = matchTokens(a.content)
  if (tokens.length === 0) return []
  const match = tokens.map((t) => `"${t}"`).join(' OR ')
  const rows = db
    .prepare(
      'SELECT a.article_label, a.content, d.title FROM articles_fts f' +
        ' JOIN articles a ON a.id = f.article_id' +
        ' JOIN documents d ON d.id = a.document_id' +
        " WHERE articles_fts MATCH ? AND a.document_id<>? ORDER BY rank LIMIT ?"
    )
    .all(match, a.document_id, RELATED_LIMIT) as unknown as DbRow[]
  return rows.map((r) => ({
    title: String(r['title']),
    label: String(r['article_label']),
    content: String(r['content'])
  }))
}

/** 案例类命中段落：chunks_fts 中 doc_type='case' 的段落，标签统一「相关段落」 */
function relatedCaseItems(db: DatabaseSync, a: ArticleContextRow): AiContextItem[] {
  const tokens = matchTokens(a.content)
  if (tokens.length === 0) return []
  const match = tokens.map((t) => `"${t}"`).join(' OR ')
  const rows = db
    .prepare(
      'SELECT c.content, d.title FROM chunks_fts f' +
        ' JOIN chunks c ON c.id = f.chunk_id' +
        ' JOIN documents d ON d.id = c.document_id' +
        " WHERE chunks_fts MATCH ? AND d.doc_type='case' ORDER BY rank LIMIT ?"
    )
    .all(match, RELATED_LIMIT) as unknown as DbRow[]
  return rows.map((r) => ({
    title: String(r['title']),
    label: '相关段落',
    content: String(r['content'])
  }))
}

/** 上下文材料：本条 → 相邻条文 → 相关法规条文（找案例时另加案例段落） */
function buildContextItems(db: DatabaseSync, a: ArticleContextRow, withCases: boolean): AiContextItem[] {
  const items: AiContextItem[] = [
    { title: a.title, label: a.label, content: a.content },
    ...neighborItems(db, a),
    ...relatedStatuteItems(db, a)
  ]
  if (withCases) items.push(...relatedCaseItems(db, a))
  return items
}

// ---------- 引用归库 ----------

/** 引用 → 库内法条：命中文档内按 article_no 取第一条；未命中给不可点击的占位（articleId=null） */
function resolveCitations(db: DatabaseSync, answer: string): AiCitation[] {
  const cites = parseCitations(answer, cn2num)
  if (cites.length === 0) return []
  const statutes = db
    .prepare("SELECT id, title FROM documents WHERE doc_type='statute' ORDER BY id")
    .all() as unknown as Array<{ id: number; title: string }>
  return cites.map((c): AiCitation => {
    const docIds = matchDocumentIds(statutes, c.name)
    if (docIds.length > 0) {
      const placeholders = docIds.map(() => '?').join(',')
      const hit = db
        .prepare(
          'SELECT a.id, a.article_label, d.title FROM articles a' +
            ' JOIN documents d ON d.id = a.document_id' +
            ` WHERE a.document_id IN (${placeholders}) AND a.article_no=?` +
            ' ORDER BY a.order_index LIMIT 1'
        )
        .get(...docIds, c.articleNo) as DbRow | undefined
      if (hit) {
        return {
          articleId: Number(hit['id']),
          title: String(hit['title']),
          label: String(hit['article_label']),
          citeText: c.citeText
        }
      }
    }
    return { articleId: null, title: c.name, label: `第${c.articleNo}条`, citeText: c.citeText }
  })
}

// ---------- 历史（追问上下文） ----------

/** 该条文最近 HISTORY_LIMIT 条归档（时间正序）；explain/cases 的空 question 按动作代填 */
function loadHistory(db: DatabaseSync, articleId: number | null): AiHistoryMessage[] {
  if (articleId === null) return []
  const rows = db
    .prepare('SELECT action, question, answer_md FROM ai_messages WHERE article_id=? ORDER BY id DESC LIMIT ?')
    .all(articleId, HISTORY_LIMIT) as unknown as DbRow[]
  const out: AiHistoryMessage[] = []
  for (const r of rows.reverse()) {
    const action = String(r['action'])
    const question = String(r['question'] ?? '') || DEFAULT_QUESTION[action] || ''
    if (question) out.push({ role: 'user', content: question })
    out.push({ role: 'assistant', content: String(r['answer_md'] ?? '') })
  }
  return out
}

// ---------- IPC 注册 ----------

/** 在跑的流式任务：taskId → 状态（结束/取消/异常后一律清理） */
const tasks = new Map<string, TaskState>()

export function registerAiIpc(): void {
  // 启动建库/迁移（连接、迁移策略都在 ./db 内）
  initDb()

  // 档案列表：按 id 升序，密钥只回掩码
  ipcMain.handle('ai:listProfiles', (): AiProfileRow[] => {
    const rows = getDb().prepare('SELECT * FROM ai_profiles ORDER BY id').all() as unknown as DbRow[]
    return rows.map(toProfileRow)
  })

  // 新建 / 更新档案：空名拒绝；更新时 apiKey 留空 = 保留原值；首条档案自动启用（否则界面无从选起）
  ipcMain.handle(
    'ai:saveProfile',
    (_e, patch: AiProfilePatch): { ok: boolean; error?: string; id?: number } => {
      const db = getDb()
      const p = (patch ?? {}) as AiProfilePatch
      const name = String(p.name ?? '').trim()
      if (!name) return { ok: false, error: '档案名称不能为空' }
      const baseUrl = String(p.baseUrl ?? '').trim()
      const model = String(p.model ?? '').trim()
      const apiKey = String(p.apiKey ?? '').trim()
      if (p.id != null) {
        const id = Number(p.id)
        const existing = getProfileRow(db, id)
        if (existing === undefined) return { ok: false, error: '档案不存在' }
        // 未提供协议时保留原值（老档案、老调用方不会被打回 openai）
        const protocol =
          p.protocol === undefined ? normalizeProtocol(existing['protocol']) : normalizeProtocol(p.protocol)
        // apiKey 留空 = 保留原值
        const nextKey = apiKey || String(existing['api_key'] ?? '')
        db.prepare(
          'UPDATE ai_profiles SET name=?, base_url=?, model=?, protocol=?, api_key=? WHERE id=?'
        ).run(name, baseUrl, model, protocol, nextKey, id)
        return { ok: true, id }
      }
      const count = db.prepare('SELECT COUNT(*) AS n FROM ai_profiles').get() as DbRow
      const isFirst = Number(count['n']) === 0
      const info = db
        .prepare(
          'INSERT INTO ai_profiles(name, base_url, model, protocol, api_key, is_active) VALUES(?,?,?,?,?,?)'
        )
        .run(name, baseUrl, model, normalizeProtocol(p.protocol), apiKey, isFirst ? 1 : 0)
      return { ok: true, id: Number(info.lastInsertRowid) }
    }
  )

  // 删除档案：删掉的若是启用档案，把剩下的第一条置为启用（始终保证「有档案就有启用档案」）
  ipcMain.handle('ai:deleteProfile', (_e, id: number): void => {
    const db = getDb()
    const profileId = Number(id)
    const row = getProfileRow(db, profileId)
    if (row === undefined) throw new Error('档案不存在')
    const wasActive = Number(row['is_active']) === 1
    db.prepare('DELETE FROM ai_profiles WHERE id=?').run(profileId)
    if (!wasActive) return
    const next = db.prepare('SELECT id FROM ai_profiles ORDER BY id LIMIT 1').get() as DbRow | undefined
    if (next) db.prepare('UPDATE ai_profiles SET is_active=1 WHERE id=?').run(Number(next['id']))
  })

  // 切换启用档案：先查存在性（避免把现有启用清 0 后无档案可用），再在同一事务里整表重设
  ipcMain.handle('ai:setActive', (_e, id: number): void => {
    const db = getDb()
    const profileId = Number(id)
    if (getProfileRow(db, profileId) === undefined) throw new Error('档案不存在')
    db.exec('BEGIN')
    try {
      db.prepare('UPDATE ai_profiles SET is_active=0 WHERE is_active<>0').run()
      db.prepare('UPDATE ai_profiles SET is_active=1 WHERE id=?').run(profileId)
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 连接已异常时放弃回滚 */
      }
      throw e
    }
  })

  // 测试连接：可传未保存的表单（显式值 > 该 id 档案 > 当前启用档案）；缺项/失败一律 {ok:false}
  ipcMain.handle(
    'ai:test',
    async (_e, probe: AiProbe): Promise<{ ok: boolean; error?: string; reply?: string }> => {
      return probeConnection(resolveConfig(getDb(), (probe ?? {}) as AiProbe))
    }
  )

  // 发起 AI 任务：流式增量经 ai:progress 回传；结束/失败都以 done:true 收尾
  ipcMain.handle(
    'ai:run',
    async (event: IpcMainInvokeEvent, req: AiRunRequest): Promise<{ ok: boolean; error?: string }> => {
      const taskId = String(req?.taskId ?? '').trim()
      if (!taskId) throw new Error('缺少任务标识')
      const sender = event.sender
      const emit = (p: AiProgress): void => {
        if (!sender.isDestroyed()) sender.send('ai:progress', p)
      }
      // 同一 taskId 重复发起：先中止旧任务（旧任务察觉到信号后自行清理）
      tasks.get(taskId)?.controller.abort()
      const state: TaskState = { controller: new AbortController(), canceled: false }
      tasks.set(taskId, state)
      const finish = (): void => {
        if (tasks.get(taskId) === state) tasks.delete(taskId)
      }
      /** 未产出任何内容就失败的统一出口：回传 + 发一条 done:true 的进度 */
      const fail = (error: string): { ok: false; error: string } => {
        finish()
        emit({ taskId, delta: '', done: true, error })
        return { ok: false, error }
      }

      try {
        const db = getDb()
        const task = String(req?.task ?? '') as AiTask
        if (task !== 'explain' && task !== 'cases' && task !== 'followup') {
          return fail(`不支持的任务类型：${String(req?.task)}`)
        }
        const cfg = resolveConfig(db, { id: req?.profileId })
        if (!isConfigured(cfg)) return fail(NOT_CONFIGURED_RUN)

        const articleId = req?.articleId == null ? null : Number(req.articleId)
        const article =
          articleId !== null && Number.isFinite(articleId) ? loadArticle(db, articleId) : null

        let messages: ChatMessage[]
        let question = ''
        if (task === 'followup') {
          const asked = String(req?.question ?? '').trim()
          if (!asked) return fail('问题不能为空')
          question = asked
          if (articleId !== null && !article) return fail('法条不存在')
          messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...buildFollowupMessages(loadHistory(db, article !== null ? articleId : null), article ? toBrief(article) : null, asked)
          ]
        } else {
          if (!article) return fail('法条不存在')
          const context = renderContext(buildContextItems(db, article, task === 'cases'))
          const user =
            task === 'explain'
              ? buildExplainPrompt(toBrief(article), context)
              : buildCasesPrompt(toBrief(article), context || '')
          messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: user }
          ]
        }

        const answer = await streamChat(cfg, messages, state, (delta) =>
          emit({ taskId, delta, done: false })
        )

        // 归库：解析引用 → 归档 ai_messages（question 仅追问有值；专题维度本轮不走）
        const citations = resolveCitations(db, answer)
        const info = db
          .prepare(
            'INSERT INTO ai_messages(article_id, topic_id, action, question, answer_md, citations) VALUES(?,?,?,?,?,?)'
          )
          .run(articleId, null, task, question, answer, JSON.stringify(citations))
        finish()
        emit({ taskId, delta: '', done: true, messageId: Number(info.lastInsertRowid) })
        return { ok: true }
      } catch (err) {
        if (state.canceled) {
          // 用户主动取消：不是错误，收尾即可（不归档半截回答）
          finish()
          emit({ taskId, delta: '', done: true })
          return { ok: false, error: '已取消' }
        }
        const reason = err instanceof Error ? err.message : String(err)
        return fail(reason)
      }
    }
  )

  // 取消任务：标记取消并中止（真正的清理在 ai:run 的 catch 里）
  ipcMain.handle('ai:cancel', (_e, taskId: string): void => {
    const state = tasks.get(String(taskId ?? ''))
    if (!state) return
    state.canceled = true
    state.controller.abort()
  })

  // 某条文的历史问答（时间正序）
  ipcMain.handle('ai:history', (_e, articleId: number): AiMessageRow[] => {
    const rows = getDb()
      .prepare('SELECT * FROM ai_messages WHERE article_id=? ORDER BY id')
      .all(Number(articleId)) as unknown as DbRow[]
    return rows.map(toMessageRow)
  })

  // 删除一条问答
  ipcMain.handle('ai:deleteMessage', (_e, id: number): void => {
    const info = getDb().prepare('DELETE FROM ai_messages WHERE id=?').run(Number(id))
    if (Number(info.changes) === 0) throw new Error('该问答不存在')
  })
}
