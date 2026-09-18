// 法规条文切分：把段落列表按 编/章/节/条 层级切成法条，并识别文档类型
// 移植自 legacy/backend/app/services/splitter.py，正则语义与状态机行为保持一致

import { cn2num } from './cnnum'

/** 条号允许的数字形态：中文数字（含零/〇 占位）或阿拉伯数字 */
const NUM = '[零〇一二三四五六七八九十百千\\d]+'

/** 行首 第X条(之X)? 后跟空白 —— 条文起始行（re.match 语义：从行首匹配） */
const ARTICLE_RE = new RegExp(`^第(${NUM})条(之[一二三四五六七八九十])?\\s*`)
/** 行首 第X编 后必须紧跟非空白（标题文字）—— 编标题行 */
const BRANCH_RE = new RegExp(`^第(${NUM})编\\s*\\S`)
/** 行首 第X章 后必须紧跟非空白 —— 章标题行 */
const CHAPTER_RE = new RegExp(`^第(${NUM})章\\s*\\S`)
/** 行首 第X节 后必须紧跟非空白 —— 节标题行 */
const SECTION_RE = new RegExp(`^第(${NUM})节\\s*\\S`)
/** 案号模式：（2019）京0108民初12345号 —— 括号年份后 0-20 字内出现"号" */
const CASE_NO_RE = /[（(]\s*\d{4}\s*[）)].{0,20}?号/
/** 判决书类文书特征词 */
const CASE_TEXT_RE = /判决书|裁定书|裁判要旨|仲裁裁决/
/** 判定为法规所需的条文起始行数下限 */
const STATUTE_MIN_ARTICLES = 3

/** 切分结果：一条法条（字段与 articles 表一一对应） */
export interface SplitArticle {
  label: string
  no: number
  branch: string
  chapter: string
  section: string
  content: string
  order_index: number
}

/** 把法规文档段落切分为法条列表；编/章/节标题行更新层级状态 */
export function splitStatute(paragraphs: string[]): SplitArticle[] {
  const articles: SplitArticle[] = []
  let current: SplitArticle | null = null
  let branch = ''
  let chapter = ''
  let section = ''
  for (const raw of paragraphs) {
    const p = raw.trim()
    if (!p) continue
    const m = ARTICLE_RE.exec(p)
    if (m) {
      // 遇条开新条：旧条入列，新条继承当前编/章/节层级
      if (current !== null) articles.push(current)
      current = {
        label: `第${m[1]}条${m[2] ?? ''}`,
        no: cn2num(m[1]) ?? 0,
        branch,
        chapter,
        section,
        content: p.slice(m[0].length).trim(),
        order_index: 0, // 切分完成后按顺序统一回填
      }
      continue
    }
    if (BRANCH_RE.exec(p)) {
      // 新编清空章/节
      branch = p
      chapter = ''
      section = ''
    } else if (CHAPTER_RE.exec(p)) {
      // 新章清空节
      chapter = p
      section = ''
    } else if (SECTION_RE.exec(p)) {
      section = p
    } else if (current !== null) {
      // 条内续段以换行并入；条前导言（尚无 current）丢弃
      current.content += `\n${p}`
    }
  }
  if (current !== null) articles.push(current)
  for (let i = 0; i < articles.length; i++) articles[i].order_index = i
  return articles
}

/** 识别文档类型：statute（法规）| case（案例文书）| other */
export function detectDocType(paragraphs: string[]): 'statute' | 'case' | 'other' {
  // 条文起始行数达到下限即判为法规（只看行首，不要求真有内容）
  const articleStarts = paragraphs.filter((p) => ARTICLE_RE.exec(p.trim())).length
  if (articleStarts >= STATUTE_MIN_ARTICLES) return 'statute'
  const text = paragraphs.join('\n')
  if (CASE_NO_RE.test(text) || CASE_TEXT_RE.test(text)) return 'case'
  return 'other'
}
