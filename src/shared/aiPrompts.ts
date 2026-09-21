// AI 提示词与输出解析（纯函数层，vitest 覆盖）
// 移植自 legacy 的 ai 部分：三任务（解读本条 / 找案例 / 追问）+ 引用解析 + 上下文渲染

/** 系统提示词：约束语言、格式、引用规范（严禁编造法条号或法规名） */
export const SYSTEM_PROMPT =
  '你是一位严谨的中国法律研究助手。回答使用简体中文与 Markdown 格式。' +
  '引用法条时必须写成《法规全名》第X条 的格式，且只能引用用户提供的材料中确实存在的条文，' +
  '严禁编造法条号或法规名。材料中没有的内容要明确说明。'

/** 追问时携带的历史轮数 / 单条截断长度（与 legacy 一致） */
export const HISTORY_LIMIT = 6
export const HISTORY_USER_CLIP = 400
export const HISTORY_ASSISTANT_CLIP = 800

/** 上下文材料渲染的字符预算 */
export const CONTEXT_BUDGET = 1800

export interface AiArticleBrief {
  /** 法规名（文档标题） */
  title: string
  /** 条文标签，如「第一千零七十七条」 */
  label: string
  content: string
}

export interface AiContextItem {
  title: string
  label: string
  content: string
}

/** 逐项渲染材料：《法规名》第X条 + 正文；超出预算时截断并加省略号 */
export function renderContext(items: AiContextItem[], budget = CONTEXT_BUDGET): string {
  const parts: string[] = []
  let used = 0
  for (const item of items) {
    const head = `《${item.title}》${item.label}\n`
    const room = budget - used
    if (room <= 60) break
    let body = item.content
    if (head.length + body.length > room) {
      body = body.slice(0, Math.max(0, room - head.length - 1)) + '…'
    }
    const block = head + body
    parts.push(block)
    used += block.length + 2
  }
  return parts.join('\n\n')
}

/** 解读本条 */
export function buildExplainPrompt(article: AiArticleBrief, context: string): string {
  return (
    '请解释下面这条法条：分「条文主旨」「适用场景」「实务要点」三部分，语言平实、面向非法律专业人士。\n\n' +
    `【目标法条】\n《${article.title}》${article.label}\n${article.content}\n\n【材料】\n${context}`
  )
}

/** 找案例：本地材料里有相关案例就归纳，没有就如实说明并提示库内无材料 */
export function buildCasesPrompt(article: AiArticleBrief, context: string): string {
  if (context.trim()) {
    return (
      '请基于下面这条法条，结合【材料】中用户本地文档库的内容，归纳相关案例或适用情形；' +
      '材料中没有案例时要如实说明，不要虚构。\n\n' +
      `【目标法条】\n《${article.title}》${article.label}\n${article.content}\n\n【材料】\n${context}`
    )
  }
  return (
    '请围绕下面这条法条，说明该条通常涉及哪些典型纠纷类型与适用情形，并提示：用户本地文档库中暂未检索到相关案例材料。\n\n' +
    `《${article.title}》${article.label}\n${article.content}`
  )
}

export interface AiHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 追问：历史（最近 6 条，截断）+ 当前条文（可选）+ 问题 */
export function buildFollowupMessages(
  history: AiHistoryMessage[],
  article: AiArticleBrief | null,
  question: string
): AiHistoryMessage[] {
  const clipped = history.slice(-HISTORY_LIMIT).map((m) => ({
    role: m.role,
    content:
      m.role === 'user'
        ? m.content.slice(0, HISTORY_USER_CLIP)
        : m.content.slice(0, HISTORY_ASSISTANT_CLIP)
  }))
  const prefix = article ? `【当前条文】\n《${article.title}》${article.label}\n${article.content}\n\n` : ''
  return [...clipped, { role: 'user', content: prefix + question }]
}

/** 引用解析：从回答文本里抓《法规名》第X条（法规名 1-60 字，禁套书名号） */
const CITATION_RE = /《([^《》]{1,60})》\s*第\s*([零〇一二三四五六七八九十百千\d]+)\s*条/g

export interface ParsedCitation {
  /** 法规名（AI 写出的原文） */
  name: string
  /** 条号（中文数字已转换；解析失败为 0） */
  articleNo: number
  /** 引用原文，用于点击跳转时的展示 */
  citeText: string
}

/** 解析回答中的引用（纯解析，不查库；含中文数字转条号） */
export function parseCitations(answer: string, toNumber: (s: string) => number | null): ParsedCitation[] {
  const out: ParsedCitation[] = []
  const seen = new Set<string>()
  CITATION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CITATION_RE.exec(answer)) !== null) {
    const name = m[1].trim()
    const no = toNumber(m[2]) ?? 0
    const key = `${name}|${no}`
    if (!name || seen.has(key)) continue
    seen.add(key)
    out.push({ name, articleNo: no, citeText: m[0] })
  }
  return out
}
