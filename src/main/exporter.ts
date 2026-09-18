// 研究报告导出：专题 → Markdown / Word（docx）研究报告
// 移植自 legacy/backend/app/services/exporter.py（结构逐段对齐：标题/层级/条文/笔记/专题笔记/落款）
// 原则：数据装载自包含（直接 getDb() 查询，不经 workspace）；md/docx 两种格式；错误一律中文抛出

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import type { ExportFormat, ExportResult } from '../shared/types'
import { getDb } from './db'

// ---------- 导出用查询行类型（自包含定义，与 workspace 解耦） ----------

/** topics 行：导出只需要名称与描述 */
interface ExportTopic {
  id: number
  name: string
  description: string
}

/** 收藏条目行：topic_items JOIN articles + documents（按 order_index 排序，对应 legacy _load 的 items） */
interface ExportItem {
  article_id: number
  label: string
  branch: string
  chapter: string
  section: string
  content: string
  doc_title: string
  category: string
}

/** 笔记行：LEFT JOIN articles（法条被删后 article_id 为空 = 专题级笔记），按 created_at, id 排序 */
interface ExportNote {
  id: number
  article_id: number | null
  content_md: string
  updated_at: string
  article_label: string | null
}

// ---------- 数据装载（移植自 legacy exporter._load） ----------

/** 装载专题 + 条目 + 笔记；专题不存在时中文抛错（渲染层错误条直接展示） */
function loadTopicData(topicId: number): {
  topic: ExportTopic
  items: ExportItem[]
  notes: ExportNote[]
} {
  const db = getDb()
  const topic = db
    .prepare('SELECT id, name, description FROM topics WHERE id=?')
    .get(topicId) as ExportTopic | undefined
  if (!topic) throw new Error('专题不存在')
  const items = db
    .prepare(
      'SELECT i.article_id, a.article_label AS label, a.branch, a.chapter, a.section,' +
        ' a.content, d.title AS doc_title, d.category' +
        ' FROM topic_items i JOIN articles a ON a.id = i.article_id' +
        ' JOIN documents d ON d.id = a.document_id' +
        ' WHERE i.topic_id = ? ORDER BY i.order_index'
    )
    .all(topicId) as unknown as ExportItem[]
  const notes = db
    .prepare(
      'SELECT n.id, n.article_id, n.content_md, n.updated_at, a.article_label' +
        ' FROM notes n LEFT JOIN articles a ON a.id = n.article_id' +
        ' WHERE n.topic_id = ? ORDER BY n.created_at, n.id'
    )
    .all(topicId) as unknown as ExportNote[]
  return { topic, items, notes }
}

// ---------- 共用小工具 ----------

/** 按行拆文本（对齐 Python splitlines：识别 \r\n / \r / \n，尾随换行不产生空行） */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 层级串：branch › chapter › section（" › " 连非空段，全空返回空串 → 调用方省略整行） */
function locationOf(item: Pick<ExportItem, 'branch' | 'chapter' | 'section'>): string {
  return [item.branch, item.chapter, item.section].filter(Boolean).join(' › ')
}

/** 拆分笔记：有 article_id 的按法条分组，其余为专题级笔记（对应 legacy _split_notes） */
function splitNotes(notes: ExportNote[]): {
  byArticle: Map<number, ExportNote[]>
  topicNotes: ExportNote[]
} {
  const byArticle = new Map<number, ExportNote[]>()
  const topicNotes: ExportNote[] = []
  for (const n of notes) {
    if (n.article_id === null || n.article_id === undefined) {
      topicNotes.push(n)
    } else {
      const key = Number(n.article_id)
      const list = byArticle.get(key)
      if (list) list.push(n)
      else byArticle.set(key, [n])
    }
  }
  return { byArticle, topicNotes }
}

/** Windows 文件名非法字符清洗（非法字符换 _，再去首尾的点与空格；清空后退回占位名） */
function reportFileName(name: string, ext: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return `${cleaned || '专题导出'}${ext}`
}

// ---------- Markdown 生成（与 legacy export_markdown 逐段对应） ----------

function buildMarkdown(
  topic: ExportTopic,
  items: ExportItem[],
  notes: ExportNote[]
): string {
  const { byArticle, topicNotes } = splitNotes(notes)
  const lines: string[] = [`# ${topic.name}`, '']
  if (topic.description) lines.push(`> ${topic.description}`, '')

  items.forEach((item, idx) => {
    lines.push(`## ${idx + 1}. ${item.label}（${item.doc_title}）`)
    const loc = locationOf(item)
    if (loc) lines.push(`**层级**：${loc}`, '')
    else lines.push('')
    lines.push(item.content, '')
    // 关联该条的笔记：每行 "> " 前缀（空行出 ">"），首行标注更新时间
    for (const n of byArticle.get(Number(item.article_id)) ?? []) {
      lines.push(`> **笔记**（${n.updated_at}）`)
      for (const l of splitLines(n.content_md)) lines.push(l ? `> ${l}` : '>')
      lines.push('')
    }
  })

  // 专题级笔记（未关联任何条文的）
  if (topicNotes.length > 0) {
    lines.push('## 专题笔记', '')
    for (const n of topicNotes) {
      lines.push(`> ${n.updated_at}`)
      for (const l of splitLines(n.content_md)) lines.push(l ? `> ${l}` : '>')
      lines.push('')
    }
  }

  lines.push('---', `*导出自 LexBench · 法研台 · 共 ${items.length} 条法条 / ${notes.length} 则笔记*`)
  return lines.join('\n')
}

// ---------- Word 生成（docx 9.x，对应 legacy export_docx） ----------

async function buildDocxBuffer(
  topic: ExportTopic,
  items: ExportItem[],
  notes: ExportNote[]
): Promise<Buffer> {
  const { byArticle, topicNotes } = splitNotes(notes)
  const children: Paragraph[] = []

  // 专题名（Heading1）+ 描述（斜体段）
  children.push(new Paragraph({ text: topic.name, heading: HeadingLevel.HEADING_1 }))
  if (topic.description) {
    children.push(
      new Paragraph({ children: [new TextRun({ text: topic.description, italics: true })] })
    )
  }

  items.forEach((item, idx) => {
    // 条目标题（Heading2）
    children.push(
      new Paragraph({
        text: `${idx + 1}. ${item.label}（${item.doc_title}）`,
        heading: HeadingLevel.HEADING_2
      })
    )
    // 层级：9pt 灰色小字（全空层级省略）
    const loc = locationOf(item)
    if (loc) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `层级：${loc}`, size: 18, color: '808080' })]
        })
      )
    }
    // 条文按行成段（12pt；空白行跳过，对齐 legacy）
    for (const line of splitLines(item.content)) {
      if (line.trim()) {
        children.push(new Paragraph({ children: [new TextRun({ text: line, size: 24 })] }))
      }
    }
    // 关联该条的笔记：斜体 + 【笔记】前缀（空行出空段；legacy 对空行会崩，这里安全降级）
    for (const n of byArticle.get(Number(item.article_id)) ?? []) {
      for (const line of splitLines(n.content_md)) {
        children.push(
          line
            ? new Paragraph({
                children: [new TextRun({ text: `【笔记】${line}`, italics: true })]
              })
            : new Paragraph({})
        )
      }
    }
  })

  // 专题级笔记区块（Heading2，正文斜体、无前缀）
  if (topicNotes.length > 0) {
    children.push(new Paragraph({ text: '专题笔记', heading: HeadingLevel.HEADING_2 }))
    for (const n of topicNotes) {
      for (const line of splitLines(n.content_md)) {
        children.push(
          line
            ? new Paragraph({ children: [new TextRun({ text: line, italics: true })] })
            : new Paragraph({})
        )
      }
    }
  }

  // Normal 默认 12pt Times New Roman（对齐 legacy 样式；中文由 Word 自动回退字体）
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
    sections: [{ children }]
  })
  return Packer.toBuffer(doc)
}

// ---------- 格式分发 ----------

/** 生成报告二进制：md → UTF-8 Buffer；docx → Packer.toBuffer */
async function generateReport(
  format: ExportFormat,
  topic: ExportTopic,
  items: ExportItem[],
  notes: ExportNote[]
): Promise<Buffer> {
  if (format === 'md') return Buffer.from(buildMarkdown(topic, items, notes), 'utf8')
  if (format === 'docx') return buildDocxBuffer(topic, items, notes)
  throw new Error(`不支持的导出格式：${String(format)}`)
}

// ---------- IPC 注册 ----------

export function registerExportIpc(): void {
  // 导出专题报告：保存对话框 → 生成内容 → 写盘；取消返回 {canceled:true}
  ipcMain.handle(
    'export:saveTopicReport',
    async (_e, topicId: number, format: ExportFormat): Promise<ExportResult> => {
      if (format !== 'md' && format !== 'docx') {
        throw new Error(`不支持的导出格式：${String(format)}`)
      }
      const { topic, items, notes } = loadTopicData(Number(topicId))
      const ext = format === 'docx' ? '.docx' : '.md'
      const options = {
        title: '导出专题报告',
        defaultPath: reportFileName(topic.name, ext),
        filters:
          format === 'docx'
            ? [{ name: 'Word 文档', extensions: ['docx'] }]
            : [{ name: 'Markdown 文档', extensions: ['md'] }]
      }
      const win = BrowserWindow.getFocusedWindow()
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { canceled: true }
      const buffer = await generateReport(format, topic, items, notes)
      let filePath = result.filePath
      if (!filePath.toLowerCase().endsWith(ext)) filePath += ext // 用户手输名可能缺扩展名
      writeFileSync(filePath, buffer)
      return { canceled: false, path: filePath }
    }
  )

  // 自测专用：跳过对话框按给定路径直接写盘（仅开发模式注册，通道名见 preload/index.ts）
  if (!app.isPackaged) {
    ipcMain.handle(
      'export:__testSaveTopicReport',
      async (_e, topicId: number, format: ExportFormat, outPath: string): Promise<ExportResult> => {
        const { topic, items, notes } = loadTopicData(Number(topicId))
        const buffer = await generateReport(format, topic, items, notes)
        writeFileSync(outPath, buffer)
        return { canceled: false, path: outPath }
      }
    )
  }
}
