// 阅读模式：划选批注（book_notes CRUD）+ 阅读进度（settings 表 JSON）+ 读书笔记导出
// 原则：与 workspace.ts / exporter.ts 同构但自包含（直接 getDb() 查询，不共用对方私有函数）；
//       错误一律 throw new Error('中文信息')，经 IPC reject 后由渲染层错误条直接展示；
//       阅读进度不建表：settings 表 key 'reading_progress:<docId>'，值为 {paraIndex, updatedAt} JSON

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import type { BookNoteInput } from '../shared/ipc'
import type { BookNoteRow, ExportFormat, ExportResult, ReadingProgress } from '../shared/types'
import { getDb, getSetting, initDb, setSetting } from './db'

// ---------- 行映射（node:sqlite 的整型可能以 bigint 到达，统一 Number() 收窄） ----------

/** node:sqlite 原始行：字段值一律 unknown，经转换函数收窄成 shared 类型 */
type DbRow = Record<string, unknown>

/** 行 → BookNoteRow：book_notes 全列（起止锚点） */
function toBookNoteRow(row: DbRow): BookNoteRow {
  return {
    id: Number(row['id']),
    document_id: Number(row['document_id']),
    content_md: String(row['content_md']),
    quote: String(row['quote'] ?? ''),
    start_para: Number(row['start_para']),
    start_offset: Number(row['start_offset']),
    end_para: Number(row['end_para']),
    end_offset: Number(row['end_offset']),
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at'])
  }
}

// ---------- 内部工具 ----------

/** 文档存在性校验（对应 legacy 404 语义） */
function requireDocument(db: DatabaseSync, documentId: number): void {
  const row = db.prepare('SELECT id FROM documents WHERE id=?').get(documentId)
  if (row === undefined) throw new Error('文档不存在')
}

/** 批注存在性校验 */
function requireBookNote(db: DatabaseSync, id: number): void {
  const row = db.prepare('SELECT id FROM book_notes WHERE id=?').get(id)
  if (row === undefined) throw new Error('批注不存在')
}

/** 数值收窄：IPC 传来的整型统一 Number() + 截断；非有限值退回 fallback（对齐列默认值） */
function intOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** 当前本地时间（与 DB 的 datetime('now','localtime') 同格式：YYYY-MM-DD HH:MM:SS） */
function localNow(): string {
  const row = getDb().prepare("SELECT datetime('now','localtime') AS now").get() as DbRow
  return String(row['now'])
}

/** 按行拆文本（对齐 Python splitlines：识别 \r\n / \r / \n，尾随换行不产生空行） */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Windows 文件名非法字符清洗（与 exporter 同规则：非法字符换 _，去首尾的点与空格；清空后退回占位名） */
function reportFileName(name: string, ext: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return `${cleaned || '读书笔记'}${ext}`
}

/** 批注的段落位置标签：单段「第X段」，跨段「第X-Y段」（para 为 seq，+1 是自然段号） */
function paraLabel(n: BookNoteRow): string {
  return n.start_para === n.end_para
    ? `第${n.start_para + 1}段`
    : `第${n.start_para + 1}-${n.end_para + 1}段`
}

/** book_notes 全列，按 start_para, start_offset 排序（同段内再按 id 稳定排序；列表与导出共用） */
function listNoteRows(db: DatabaseSync, documentId: number): BookNoteRow[] {
  const rows = db
    .prepare('SELECT * FROM book_notes WHERE document_id=? ORDER BY start_para, start_offset, id')
    .all(documentId) as unknown as DbRow[]
  return rows.map(toBookNoteRow)
}

// ---------- 数据装载（导出自包含，不经 workspace） ----------

/** 导出装载：文档标题 + 全部批注；文档不存在时中文抛错 */
function loadExportData(documentId: number): { title: string; notes: BookNoteRow[] } {
  const db = getDb()
  const doc = db.prepare('SELECT id, title FROM documents WHERE id=?').get(documentId) as
    | DbRow
    | undefined
  if (!doc) throw new Error('文档不存在')
  return { title: String(doc['title']), notes: listNoteRows(db, documentId) }
}

// ---------- Markdown 生成 ----------

function buildMarkdown(title: string, notes: BookNoteRow[]): string {
  const lines: string[] = [`# ${title}`, '', `> 阅读笔记 · 共 ${notes.length} 则`, '']
  if (notes.length === 0) lines.push('暂无批注', '')
  for (const n of notes) {
    // 引用块：标注段落位置（跨段为「第X-Y段」），原文逐行 "> " 前缀（空行出 ">"）
    lines.push(`> **引用**（${paraLabel(n)}）`)
    for (const l of splitLines(n.quote)) lines.push(l ? `> ${l}` : '>')
    lines.push('')
    // 批注：首行加「**批注**：」标签，其余行原样输出（多行批注不丢换行）
    splitLines(n.content_md).forEach((l, i) => lines.push(i === 0 ? `**批注**：${l}` : l))
    lines.push('', '---', '')
  }
  lines.push('*导出自 LexBench · 法研台*')
  return lines.join('\n')
}

// ---------- Word 生成（docx 9.x，写法参考 exporter.ts 的精简版） ----------

async function buildDocxBuffer(title: string, notes: BookNoteRow[]): Promise<Buffer> {
  const children: Paragraph[] = []

  // 书名（Heading1）+ 计数副题（斜体段，与 md 头部对应）
  children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }))
  children.push(
    new Paragraph({
      children: [new TextRun({ text: `阅读笔记 · 共 ${notes.length} 则`, italics: true })]
    })
  )
  if (notes.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: '暂无批注' })] }))
  }

  for (const n of notes) {
    // 引用：斜体段，每行「引用：」前缀（空行出空段，安全降级）
    for (const l of splitLines(n.quote)) {
      children.push(
        l
          ? new Paragraph({ children: [new TextRun({ text: `引用：${l}`, italics: true })] })
          : new Paragraph({})
      )
    }
    // 批注：正常段，首行「批注：」标签、其余行原样（空白行出空段）
    splitLines(n.content_md).forEach((l, i) => {
      children.push(
        l
          ? new Paragraph({
              children: [new TextRun({ text: i === 0 ? `批注：${l}` : l })]
            })
          : new Paragraph({})
      )
    })
    // 小字时间（灰色 9pt，同 topic 报告「层级」小字样式）
    children.push(
      new Paragraph({
        children: [new TextRun({ text: n.updated_at, size: 18, color: '808080' })]
      })
    )
  }

  // Normal 默认 12pt Times New Roman（对齐 topic 报告样式；中文由 Word 自动回退字体）
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
  title: string,
  notes: BookNoteRow[]
): Promise<Buffer> {
  if (format === 'md') return Buffer.from(buildMarkdown(title, notes), 'utf8')
  if (format === 'docx') return buildDocxBuffer(title, notes)
  throw new Error(`不支持的导出格式：${String(format)}`)
}

// ---------- IPC 注册 ----------

export function registerReadingIpc(): void {
  // 启动建库/迁移（连接、迁移策略都在 ./db 内）
  initDb()

  // 某文档的全部批注：para_index, quote_start 排序；文档不存在时中文抛错
  ipcMain.handle('reading:listBookNotes', (_e, documentId: number): BookNoteRow[] => {
    const db = getDb()
    requireDocument(db, Number(documentId))
    return listNoteRows(db, Number(documentId))
  })

  // 新建批注：文档必须存在；内容 trim 后为空拒绝；锚点收窄并按文档序归一（起在止前）；返回完整 BookNoteRow
  ipcMain.handle(
    'reading:createBookNote',
    (_e, documentId: number, note: BookNoteInput): BookNoteRow => {
      const db = getDb()
      requireDocument(db, Number(documentId))
      const raw = (note ?? {}) as Partial<BookNoteInput>
      const content = String(raw.contentMd ?? '').trim()
      if (!content) throw new Error('批注内容为空')
      let sp = intOr(raw.startPara, -1)
      let so = intOr(raw.startOffset, 0)
      let ep = intOr(raw.endPara, -1)
      let eo = intOr(raw.endOffset, 0)
      if (sp > ep || (sp === ep && so > eo)) {
        // 选区方向反了（渲染层正常不会发生）：按文档序交换
        ;[sp, ep] = [ep, sp]
        ;[so, eo] = [eo, so]
      }
      const info = db
        .prepare(
          'INSERT INTO book_notes(document_id, content_md, quote, start_para, start_offset, end_para, end_offset)' +
            ' VALUES(?,?,?,?,?,?,?)'
        )
        .run(Number(documentId), content, String(raw.quote ?? ''), sp, so, ep, eo)
      const row = db
        .prepare('SELECT * FROM book_notes WHERE id=?')
        .get(Number(info.lastInsertRowid)) as DbRow
      return toBookNoteRow(row)
    }
  )

  // 编辑批注：先查存在性（404 先于 422），只改 content_md + updated_at（quote/锚点不可变）
  ipcMain.handle('reading:updateBookNote', (_e, id: number, contentMd: string): void => {
    const db = getDb()
    requireBookNote(db, Number(id))
    const content = String(contentMd ?? '').trim()
    if (!content) throw new Error('批注内容为空')
    db.prepare("UPDATE book_notes SET content_md=?, updated_at=datetime('now','localtime') WHERE id=?").run(
      content,
      Number(id)
    )
  })

  // 删除批注
  ipcMain.handle('reading:deleteBookNote', (_e, id: number): void => {
    const info = getDb().prepare('DELETE FROM book_notes WHERE id=?').run(Number(id))
    if (Number(info.changes) === 0) throw new Error('批注不存在')
  })

  // 阅读进度：settings 表 JSON；从未读过/值损坏一律返回 null（渲染层从头展示）
  ipcMain.handle('reading:getProgress', (_e, documentId: number): ReadingProgress | null => {
    const raw = getSetting(`reading_progress:${Number(documentId)}`)
    if (raw === undefined) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return null
      const p = parsed as { paraIndex?: unknown; updatedAt?: unknown }
      const paraIndex = Number(p.paraIndex)
      if (!Number.isFinite(paraIndex)) return null
      return { paraIndex, updatedAt: String(p.updatedAt ?? '') }
    } catch {
      return null
    }
  })

  // 保存阅读进度：UPSERT 该 key（db.ts setSetting 即 UPSERT 语义），updatedAt 为本地时间串
  ipcMain.handle('reading:saveProgress', (_e, documentId: number, paraIndex: number): void => {
    setSetting(
      `reading_progress:${Number(documentId)}`,
      JSON.stringify({ paraIndex: Number(paraIndex), updatedAt: localNow() })
    )
  })

  // 导出读书笔记：保存对话框 → 生成报告 → 写盘；取消返回 {canceled:true}
  ipcMain.handle(
    'export:saveBookNotes',
    async (_e, documentId: number, format: ExportFormat): Promise<ExportResult> => {
      if (format !== 'md' && format !== 'docx') {
        throw new Error(`不支持的导出格式：${String(format)}`)
      }
      const { title, notes } = loadExportData(Number(documentId))
      const ext = format === 'docx' ? '.docx' : '.md'
      const options = {
        title: '导出读书笔记',
        defaultPath: reportFileName(title, ext),
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
      const buffer = await generateReport(format, title, notes)
      let filePath = result.filePath
      if (!filePath.toLowerCase().endsWith(ext)) filePath += ext // 用户手输名可能缺扩展名
      writeFileSync(filePath, buffer)
      return { canceled: false, path: filePath }
    }
  )

  // 自测专用：跳过对话框按给定路径直接写盘（仅开发模式注册，通道名见 preload/index.ts）
  if (!app.isPackaged) {
    ipcMain.handle(
      'export:__testSaveBookNotes',
      async (_e, documentId: number, format: ExportFormat, outPath: string): Promise<ExportResult> => {
        const { title, notes } = loadExportData(Number(documentId))
        const buffer = await generateReport(format, title, notes)
        writeFileSync(outPath, buffer)
        return { canceled: false, path: outPath }
      }
    )
  }
}
