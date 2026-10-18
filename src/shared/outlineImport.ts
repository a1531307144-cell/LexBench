// 通用大纲导入（阶段3·纯函数层）：OPML / HTML / Markdown → 中间树 → OutlineNode[]。
// 对外表述一律「业界通用格式」；本层零 IO（文件读取、图片下载、落库都在主进程），
// 与 outlineExport.ts 对称，可被 vitest 直测。
//
// 设计要点（对齐 2026-10-18 定稿）：
// - 格式嗅探：扩展名优先，缺失时看内容头；
// - 描述承载：OPML `_note`（OPML 生态通用扩展）/ HTML 内附加段落 → 该节点第一个子节点；
// - 任务态 `_complete` → 文本前缀 [✓]/[ ]（可见降级）；颜色/样式类属性丢弃；
// - 图片：抽取 URL（OPML/HTML 的 <img src>、MD 的 ![alt](url)），归一化后每节点挂首图为
//   node.image，其余以行内文本保留（不丢信息）；下载落盘由主进程负责；
// - MD 为降级路径：缩进拿不准时宁可同层拍平（结构错误比层级丢失更难修复）。

import type { OutlineNode } from './types'

export type ImportFormat = 'opml' | 'html' | 'md'

/** 解析产物（中间树）：图片为远程 URL，待主进程下载落盘后回填 node.image */
export interface ImportedNode {
  text: string
  children: ImportedNode[]
  images: string[]
}

export interface ImportedDoc {
  title: string
  nodes: ImportedNode[]
  format: ImportFormat
  /** 文档级图片总数（预检展示用） */
  imageCount: number
}

// ---------- HTML 实体解码（导入侧通用） ----------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m)
}

// ---------- 格式嗅探 ----------

export function sniffFormat(fileName: string, content: string): ImportFormat | null {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.opml')) return 'opml'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md'
  // 扩展名缺失/不对时看内容头
  const head = content.slice(0, 400)
  if (/<\?xml/i.test(head) && /<opml/i.test(head)) return 'opml'
  if (/<ul[\s>]/i.test(head) || /<html/i.test(head)) return 'html'
  if (/^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s/m.test(content)) return 'md'
  return null
}

// ---------- OPML ----------

/** 提取 <head>...<title>...</title>（XML 文档头注记） */
function opmlHeadTitle(content: string): string {
  const m = /<head[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i.exec(content)
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '').trim()) : ''
}

/** 解析单个 <outline ...> 标签的属性 map（容忍单双引号与换行） */
function parseOutlineAttrs(tagInner: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tagInner))) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '')
  }
  return attrs
}

/**
 * OPML 解析（手写栈式，零依赖）：
 * 顶层 body 内 <outline> 递归；text/title 属性为节点文本；_note 为描述（生态通用扩展）
 * → 该节点第一个子节点；_complete="true|false" → [✓]/[ ] 前缀。
 */
export function parseOpml(content: string, fallbackTitle: string): ImportedDoc {
  const title = opmlHeadTitle(content) || fallbackTitle
  const bodyM = /<body[^>]*>([\s\S]*)<\/body>/i.exec(content)
  const body = bodyM ? bodyM[1] : content

  const roots: ImportedNode[] = []
  // 栈元素：{ list }——当前正在填充的子节点数组
  const stack: { list: ImportedNode[] }[] = [{ list: roots }]
  let imageCount = 0

  // 注意：属性段用 [^>]* 贪婪到 >，自闭合靠「整标签以 /> 结尾」判定——
  // 若把 / 放进排除集会截断含斜杠的 URL 属性值
  const tagRe = /<outline\b([^>]*)>|<\/outline\s*>/gi
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(body))) {
    const raw = m[0]
    if (/^<\//.test(raw)) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const attrs = parseOutlineAttrs(m[1] ?? '')
    const text = (attrs['text'] ?? attrs['title'] ?? '').trim()
    const rawImgs = attrs['_mubu_images'] ?? attrs['images'] ?? ''
    const images = rawImgs ? extractImageUrls(rawImgs) : []
    imageCount += images.length
    let nodeText = text
    // _complete 属性存在即任务节点：true=[✓]、false/空=[ ]（OPML 生态通用约定）
    if ('_complete' in attrs) {
      nodeText = `${attrs['_complete'] === 'true' ? '[✓]' : '[ ]'} ${nodeText}`
    }
    const node: ImportedNode = { text: nodeText, children: [], images }
    // 描述 → 第一个子节点
    const note = (attrs['_note'] ?? '').trim()
    if (note) node.children.push({ text: note, children: [], images: [] })
    stack[stack.length - 1].list.push(node)
    if (!/\/\s*>$/.test(raw)) stack.push({ list: node.children }) // 非自闭合 → 进入其 children
  }

  return { title, nodes: roots, format: 'opml', imageCount }
}

/** 图片字段提取：JSON 数组（URI 编码或裸 JSON）或逗号分隔 URL 列表 */
function extractImageUrls(raw: string): string[] {
  const s = raw.trim()
  if (!s) return []
  try {
    const decoded = decodeURIComponent(s)
    const arr = JSON.parse(decoded)
    if (Array.isArray(arr)) {
      return arr
        .map((x) => (typeof x === 'string' ? x : (x?.['url'] ?? x?.['src'] ?? '')))
        .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u))
    }
  } catch {
    /* 非 JSON → 走逗号分隔 */
  }
  return s
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//.test(u))
}

// ---------- HTML（通用 ul/ol/li 嵌套——业界 HTML 大纲通用形态） ----------

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function extractImgs(html: string): string[] {
  const urls: string[] = []
  const re = /<img[^>]*\ssrc\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const u = decodeEntities(m[2] ?? m[3] ?? '')
    if (u) urls.push(u)
  }
  return urls
}

/**
 * HTML 大纲解析：任意嵌套 <ul>/<ol> + <li>（不依赖特定 class——业界通用形态）；
 * li 内直接文本为主文，内嵌 ul/ol 为子级；行内 <img> 抽为节点图片。
 */
export function parseHtmlOutline(content: string, fallbackTitle: string): ImportedDoc {
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(content)
  const title = titleM ? stripTags(titleM[1]) || fallbackTitle : fallbackTitle

  let imageCount = 0

  const bodyM = /<body[^>]*>([\s\S]*)<\/body>/i.exec(content)
  const body = bodyM ? bodyM[1] : content

  let nodes: ImportedNode[]
  if (/<(ul|ol)[\s>]/i.test(body)) {
    // li 标签游走栈：嵌套 li 靠栈天然表达层级（正则非贪婪会在嵌套处提前闭合，不能用）
    nodes = walkListWithText(body)
    imageCount = countImages(nodes)
  } else {
    // 降级：段落/换行拍平为同层节点
    nodes = body
      .split(/<\/p>|<br\s*\/?>/i)
      .map((seg) => ({
        text: stripTags(seg),
        children: [],
        images: extractImgs(seg)
      }))
      .filter((n) => n.text || n.images.length)
    imageCount = nodes.reduce((s, n) => s + n.images.length, 0)
  }

  return { title, nodes, format: 'html', imageCount }
}

function countImages(nodes: ImportedNode[]): number {
  let c = 0
  for (const n of nodes) {
    c += n.images.length + countImages(n.children)
  }
  return c
}

/** HTML 列表游走（文本+li+img 一次成型）：token 流维护 li 栈，文本段归当前栈顶 */
function walkListWithText(html: string): ImportedNode[] {
  interface LiFrame {
    parts: string[]
    children: ImportedNode[]
    images: string[]
  }
  const roots: ImportedNode[] = []
  const stack: LiFrame[] = []
  const cur = (): LiFrame | null => (stack.length ? stack[stack.length - 1] : null)
  const attach = (node: ImportedNode): void => {
    const f = cur()
    if (f) f.children.push(node)
    else roots.push(node)
  }
  const tokenRe =
    /<li\b[^>]*>|<\/li\s*>|<img[^>]*\ssrc\s*=\s*("([^"]*)"|'([^']*)')[^>]*>|<[^>]+>|[^<]+/gi
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(html))) {
    const raw = m[0]
    if (/^<li\b/i.test(raw)) {
      stack.push({ parts: [], children: [], images: [] })
    } else if (/^<\/li/i.test(raw)) {
      const frame = stack.pop()
      if (!frame) continue
      const text = stripTags(frame.parts.join(''))
      if (!text && !frame.images.length && frame.children.length) {
        // 空壳 li（只有子列表）：子列表上提
        for (const c of frame.children) attach(c)
      } else {
        attach({ text, children: frame.children, images: frame.images })
      }
    } else if (/^<img/i.test(raw)) {
      const f = cur()
      const u = decodeEntities(m[2] ?? m[3] ?? '')
      if (f && u) f.images.push(u)
    } else if (raw.startsWith('<')) {
      // 其余标签忽略（保留文本流向当前帧）
    } else {
      const f = cur()
      if (f) f.parts.push(raw)
      // 游走范围之外的散文本忽略（列表外内容不进树）
    }
  }
  return roots
}

// ---------- Markdown（降级路径：宁平不深） ----------

/**
 * Markdown 大纲解析（降级专用）：
 * - 列表符 `-`/`*`/`+`/`N.` 开启节点；前导空格推断层级（2/4 空格或 tab 一级）；
 * - `#` 标题 → 加粗文本行（层级由列表结构另算）；`![alt](url)` 抽图；
 * - 深度拿不准时同层拍平——结构错误比层级丢失更难修复。
 */
export function parseMarkdownOutline(content: string, fallbackTitle: string): ImportedDoc {
  const titleM = /^#\s+(.+)$/m.exec(content)
  const title = titleM ? titleM[1].trim() : fallbackTitle

  const images: { node: ImportedNode; url: string }[] = []
  const roots: ImportedNode[] = []
  // 栈：每层最后一个节点（用于挂子）
  const stack: { depth: number; node: ImportedNode }[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const listM = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(rawLine)
    if (!listM) {
      // 非列表行：# 标题行 → 加粗文本节点；引用/普通文本 → 文本节点（同层宁平不深）
      const headingM = /^#{1,6}\s+(.*)$/.exec(rawLine.trim())
      if (headingM) {
        roots.push({ text: `**${headingM[1].trim()}**`, children: [], images: [] })
      } else if (!/^(---|\*\*\*|===)\s*$/.test(rawLine.trim())) {
        roots.push({ text: rawLine.trim(), children: [], images: [] })
      }
      continue
    }
    const indentStr = listM[1]
    const depth = indentStr.replace(/\t/g, '  ').length / 2 // tab=一级、2空格=一级
    let text = listM[3].trim()
    // 任务列表降级
    const taskM = /^\[([ xX])\]\s*(.*)$/.exec(text)
    if (taskM) text = `${taskM[1].toLowerCase() === 'x' ? '[✓]' : '[ ]'} ${taskM[2]}`
    // 抽图（保留其余文本）
    const nodeImages: string[] = []
    text = text
      .replace(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, (_, url) => {
        nodeImages.push(String(url))
        return ' '
      })
      .replace(/\s+/g, ' ')
      .trim()
    const node: ImportedNode = { text, children: [], images: nodeImages }
    for (const u of nodeImages) images.push({ node, url: u })

    // 挂载：弹出不浅于本层的栈顶，再挂到当前栈顶 children 或 roots
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else roots.push(node)
    stack.push({ depth, node })
  }

  return { title, nodes: roots, format: 'md', imageCount: images.length }
}

// ---------- 统一入口 + 归一化 → OutlineNode[] ----------

export function parseImportedFile(
  fileName: string,
  content: string,
  genId: () => string
): ImportedDoc {
  const fallbackTitle = fileName.replace(/\.[^.]+$/, '')
  const format = sniffFormat(fileName, content)
  if (!format) throw new Error('不支持的格式（支持 OPML / HTML / Markdown）')
  if (format === 'opml') return parseOpml(content, fallbackTitle)
  if (format === 'html') return parseHtmlOutline(content, fallbackTitle)
  return parseMarkdownOutline(content, fallbackTitle)
}

/**
 * 中间树 → OutlineNode[]：生成 id、首图挂 node.image（其余图以文本保留）、
 * 空文本节点清理（有子/有图的保留壳）。
 */
export function toOutlineNodes(nodes: ImportedNode[], genId: () => string): OutlineNode[] {
  const out: OutlineNode[] = []
  for (const n of nodes) {
    const children = toOutlineNodes(n.children, genId)
    const extraImgs = n.images.slice(1)
    let text = n.text
    if (extraImgs.length) text = [text, ...extraImgs.map((u) => `![图片](${u})`)].filter(Boolean).join(' ')
    const hasValue = text || n.images.length || children.length
    if (!hasValue) continue // 纯空节点丢弃
    const node: OutlineNode = { id: genId(), text, children }
    if (n.images.length) node.image = n.images[0]
    out.push(node)
  }
  return out
}
