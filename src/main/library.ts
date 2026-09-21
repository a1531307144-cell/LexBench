// 资料库：文档导入 + 资料 IPC（列表/详情/删除/状态/法条阅读与修正）
// 移植自 legacy/backend/app/services/importer.py + indexer.py + routers/documents.py
// 原则：单文件失败不阻断批量导入；FTS 行不随外键级联，删除/改条必须手动维护；
//       依赖 ./db 的 initDb()/getDb()（node:sqlite 单例连接，事务用 BEGIN/COMMIT exec 实现）

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import mammoth from 'mammoth'
import type { PickFilesResult } from '../shared/ipc'
import type {
  ArticleDetail,
  ArticleNeighbors,
  ArticleRow,
  ChunkRow,
  DocStatus,
  DocType,
  DocumentDetail,
  DocumentRow,
  ImportResultItem,
  ImportTypeChoice
} from '../shared/types'
import { detectDocType, splitStatute } from '@shared/splitter'
import type { SplitArticle } from '@shared/splitter'
import { tokenize } from '@shared/tokenize'
import { getDb, initDb } from './db'

/** 案例等非法规文档的分块目标字数（对应 legacy chunk_paragraphs target=500） */
const CHUNK_TARGET = 500
/** 法规切分后平均条文长度低于该值时标记 needs_review（legacy _MIN_AVG_ARTICLE_LEN） */
const MIN_AVG_ARTICLE_LEN = 20
/** PDF 全部文本合计少于该字符数判定为扫描版（无文本层） */
const PDF_MIN_TEXT_CHARS = 20
/** 标题尾部日期后缀：民法典_20210101 / 民法典 2021 / 民法典-20210101 */
const DATE_SUFFIX_RE = /[_\s-]\d{4,8}$/

// ---------- 文件名 / 哈希 ----------

/** 标题清洗：去扩展名、去尾部日期后缀；清洗后为空则退回原文件名主干 */
function cleanTitle(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '')
  const cleaned = stem.replace(DATE_SUFFIX_RE, '').trim()
  return cleaned || stem
}

/** 文件内容 SHA-256（去重键；同名不同内容不会误判，同名同内容只收一份） */
function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

// ---------- 三种格式的段落解析 ----------

/** docx：mammoth 抽纯文本，按换行拆段、trim 去空（表格/页眉页脚内容会丢失，与 legacy 一致） */
async function extractDocxParagraphs(filePath: string): Promise<string[]> {
  const { value } = await mammoth.extractRawText({ path: filePath })
  return value
    .split(/\r\n|\n|\r/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** pdfjs-dist 按需加载：体积大且启动用不到；legacy 构建才能在 Node 主进程运行 */
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjsModule: PdfjsModule | null = null
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsModule) pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsModule
}

/** PDF 轻探测：页数 + 前 3 页文本量（判定扫描/文字），不逐页提取（真实书籍逐页提取太慢） */
async function probePdf(filePath: string): Promise<{ numPages: number; scanned: boolean }> {
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(readFileSync(filePath))
  const loadingTask = pdfjs.getDocument({ data })
  const doc = await loadingTask.promise
  try {
    let sample = ''
    for (let i = 1; i <= Math.min(3, doc.numPages); i++) {
      const tc = await (await doc.getPage(i)).getTextContent()
      for (const item of tc.items) {
        if ('str' in item) sample += item.str
      }
      if (sample.length > PDF_MIN_TEXT_CHARS) break
    }
    return { numPages: doc.numPages, scanned: sample.length < PDF_MIN_TEXT_CHARS }
  } finally {
    await loadingTask.destroy()
  }
}

/** pdf：逐页 getTextContent，按 item.hasEOL 重建行，**按页返回**（页 = 索引/笔记/进度单元） */
async function extractPdfPages(filePath: string): Promise<string[][]> {
  const pdfjs = await loadPdfjs()
  // 复制一份普通 Uint8Array，避免 pdfjs 接管/转移 Buffer 底层内存
  const data = new Uint8Array(readFileSync(filePath))
  // destroy 挂在 loadingTask 上（pdfjs v4+ 起 PDFDocumentProxy 不再暴露 destroy）
  const loadingTask = pdfjs.getDocument({ data })
  const doc = await loadingTask.promise
  try {
    const pages: string[][] = []
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo)
      const text = await page.getTextContent()
      const lines: string[] = []
      let line = ''
      const flush = (): void => {
        const t = line.trim()
        if (t) lines.push(t)
        line = ''
      }
      for (const item of text.items) {
        if (!('str' in item)) continue // TextMarkedContent 无文本内容
        line += item.str
        if (item.hasEOL) flush()
      }
      flush() // 页尾最后一行可能没有 EOL 标记
      pages.push(lines)
    }
    return pages
  } finally {
    await loadingTask.destroy()
  }
}

/** txt：UTF-8（严格模式，先剥 BOM）→ GB18030 → UTF-8 替换兜底；按行拆段去空 */
function extractTxtParagraphs(filePath: string): string[] {
  const raw = readFileSync(filePath)
  let text: string
  try {
    const body =
      raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
        ? raw.subarray(3)
        : raw
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    try {
      // GB18030 覆盖绝大多数中文旧文件；非致命模式自动替换坏字节
      text = new TextDecoder('gb18030').decode(raw)
    } catch {
      text = raw.toString('utf8')
    }
  }
  return text
    .split(/\r\n|\n|\r/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// ---------- 索引（移植自 indexer.py） ----------

/** 贪心分块：段落依次累积，满 target 字数即封一块（\n 相接），尾段独立成块；单段超长不再内切 */
function chunkParagraphs(paragraphs: string[], target = CHUNK_TARGET): string[] {
  const chunks: string[] = []
  let buf: string[] = []
  let size = 0
  for (const p of paragraphs) {
    buf.push(p)
    size += p.length
    if (size >= target) {
      chunks.push(buf.join('\n'))
      buf = []
      size = 0
    }
  }
  if (buf.length > 0) chunks.push(buf.join('\n'))
  return chunks
}

/** 写入法条行 + articles_fts（content 存切词后文本），并回填文档 article_count。不管理事务，由调用方包裹 */
function indexArticles(db: DatabaseSync, documentId: number, articles: SplitArticle[]): void {
  const insertArticle = db.prepare(
    'INSERT INTO articles(document_id, article_label, article_no, branch, chapter, section, content, order_index)' +
      ' VALUES(?,?,?,?,?,?,?,?)'
  )
  const insertFts = db.prepare('INSERT INTO articles_fts(article_id, content) VALUES(?,?)')
  for (const a of articles) {
    const info = insertArticle.run(
      documentId,
      a.label,
      a.no,
      a.branch,
      a.chapter,
      a.section,
      a.content,
      a.order_index
    )
    insertFts.run(Number(info.lastInsertRowid), tokenize(a.content))
  }
  db.prepare('UPDATE documents SET article_count=? WHERE id=?').run(articles.length, documentId)
}

/** 写入段落块 + chunks_fts（content 存切词后文本）。不管理事务，由调用方包裹 */
function indexChunks(db: DatabaseSync, documentId: number, chunks: string[]): void {
  const insertChunk = db.prepare('INSERT INTO chunks(document_id, seq, content) VALUES(?,?,?)')
  const insertFts = db.prepare('INSERT INTO chunks_fts(chunk_id, content) VALUES(?,?)')
  for (let i = 0; i < chunks.length; i++) {
    const info = insertChunk.run(documentId, i, chunks[i])
    insertFts.run(Number(info.lastInsertRowid), tokenize(chunks[i]))
  }
}

/**
 * 事务包裹：BEGIN → fn → COMMIT，异常时 ROLLBACK。
 * node:sqlite 无 .transaction() helper；事务块内全部为同步 DB 调用，单线程主进程内不会被其它 handler 打断。
 */
function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 连接已异常时放弃回滚 */
    }
    throw e
  }
}

// ---------- 单文件导入（移植自 importer.py） ----------

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 逐文件导入：解析 → 哈希去重 → 类型判定/切分 → 归档原件 → 单事务入库；任何一步失败只影响本文件 */
async function importOne(
  filePath: string,
  filesDir: string,
  category: string,
  typeChoice: ImportTypeChoice
): Promise<ImportResultItem> {
  const fileName = basename(filePath)
  const title = cleanTitle(fileName)
  const suffix = extname(fileName).toLowerCase()
  const fail = (message: string): ImportResultItem => ({
    status: 'failed',
    title,
    document_id: 0,
    doc_type: 'other', // 占位：失败项没有有效类型
    article_count: 0,
    message
  })

  // ①② 解析阶段（.doc 拒绝 / 未知后缀 / 空文档）
  // PDF 先轻探测（页数 + 前 3 页文本量）：书籍型 PDF 走快路径——不逐页提取文字
  // （真实书籍逐页提取可达分钟级且无进度反馈）；页面模式按需渲染，文字提取留给 OCR 阶段
  let pages: string[][] | null = null // 每页的行（docx/txt 视为单页）；PDF 快路径为 null
  let pdfFast: { numPages: number; scanned: boolean } | null = null
  try {
    if (suffix === '.doc') return fail('不支持 .doc 老格式，请先转换为 .docx')
    if (suffix !== '.docx' && suffix !== '.pdf' && suffix !== '.txt') {
      return fail(`不支持的文件类型 ${suffix || '(无后缀)'}`)
    }
    if (suffix === '.pdf') {
      const probe = await probePdf(filePath)
      const wantsBook = typeChoice === 'book' || (typeChoice === 'auto' && probe.scanned)
      if (wantsBook) pdfFast = { numPages: probe.numPages, scanned: probe.scanned }
      else pages = await extractPdfPages(filePath)
    } else if (suffix === '.docx') {
      pages = [await extractDocxParagraphs(filePath)]
    } else {
      pages = [extractTxtParagraphs(filePath)]
    }
  } catch (e) {
    return fail(`解析失败：${errMessage(e)}`)
  }
  const paragraphs = pages ? pages.flat() : []
  const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0)
  const pdfScanned = !!pdfFast?.scanned
  if (pages && paragraphs.length === 0 && !pdfScanned) return fail('文档内容为空')

  // ③⑥⑦ 哈希去重 → 类型判定/切分 → 归档原件 → 单事务入库
  const db = getDb()
  try {
    const fileHash = sha256File(filePath)
    const existing = db
      .prepare('SELECT id, doc_type, article_count FROM documents WHERE file_hash=?')
      .get(fileHash) as { id: number; doc_type: string; article_count: number } | undefined
    if (existing) {
      return {
        status: 'duplicate',
        title,
        document_id: Number(existing.id),
        doc_type: existing.doc_type as DocType,
        article_count: Number(existing.article_count),
        message: ''
      }
    }

    // 类型判定：手动指定优先；auto 走启发式（扫描版 PDF 自动按书籍入库，走页面阅读模式）。
    // 法规切条（条数为 0 或平均条长过短 → needs_review），案例/书籍/其它恒 parsed
    const effectiveChoice: ImportTypeChoice = typeChoice === 'auto' && pdfScanned ? 'book' : typeChoice
    const docType: DocType = pdfFast
      ? 'book'
      : effectiveChoice === 'auto'
        ? detectDocType(paragraphs)
        : effectiveChoice
    const articles = docType === 'statute' ? splitStatute(paragraphs) : []
    let status: DocStatus = 'parsed'
    if (docType === 'statute') {
      const avg =
        articles.length > 0
          ? articles.reduce((sum, a) => sum + a.content.length, 0) / articles.length
          : 0
      if (articles.length === 0 || avg < MIN_AVG_ARTICLE_LEN) status = 'needs_review'
    }

    // 先归档原件再入库：入库失败不产生数据库半成品（归档文件按内容哈希命名，重导直接覆盖）
    mkdirSync(filesDir, { recursive: true })
    copyFileSync(filePath, join(filesDir, `${fileHash}${suffix}`))

    let chunks: string[] = []
    if (docType === 'book') {
      // PDF 书籍：一页一 chunk（seq=页序，页笔记/进度以页定位），内容留空——
      // 页面按需渲染，全文检索 PDF 书籍留给 OCR/按需回填阶段；其余书籍一段一 chunk
      chunks = pdfFast ? Array.from({ length: pdfFast.numPages }, () => '') : paragraphs
    } else if (docType !== 'statute') {
      chunks = chunkParagraphs(paragraphs)
    }
    const docId = withTransaction(db, () => {
      const info = db
        .prepare(
          'INSERT INTO documents(title, doc_type, category, file_hash, original_path, status, file_ext, group_id)' +
            ' VALUES(?,?,?,?,?,?,?,?)'
        )
        .run(title, docType, category, fileHash, filePath, status, suffix, resolveGroupId(db, docType, category))
      const id = Number(info.lastInsertRowid)
      if (docType === 'statute') indexArticles(db, id, articles)
      else indexChunks(db, id, chunks)
      return id
    })
    return {
      status: 'imported',
      title,
      document_id: docId,
      doc_type: docType,
      article_count: articles.length,
      message: ''
    }
  } catch (e) {
    return fail(`入库失败：${errMessage(e)}`)
  }
}

/** 原件归档目录：与 lexbench.db 同在用户数据目录 */
function getFilesDir(): string {
  return join(app.getPath('userData'), 'files')
}

/** 按「类型 + 名称」找分类文件夹，没有就建一个（返回 id；名称为空返回 null） */
export function resolveGroupId(db: DatabaseSync, docType: DocType, name: string): number | null {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return null
  const existing = db
    .prepare('SELECT id FROM doc_groups WHERE doc_type=? AND name=?')
    .get(docType, trimmed) as { id: number } | undefined
  if (existing) return Number(existing.id)
  const info = db.prepare('INSERT INTO doc_groups(doc_type, name) VALUES(?,?)').run(docType, trimmed)
  return Number(info.lastInsertRowid)
}

/** 批量导入（IPC 与预置种子共用）：逐文件顺序处理，单文件失败不阻断 */
export async function importFiles(
  paths: string[],
  category: string,
  typeChoice: ImportTypeChoice
): Promise<ImportResultItem[]> {
  const filesDir = getFilesDir()
  const results: ImportResultItem[] = []
  for (const p of paths) {
    results.push(await importOne(String(p), filesDir, category, typeChoice))
  }
  return results
}

/** 本次启动是否刚预置了法条（渲染层显示一次性提示用） */
let seedAppliedThisRun = false
let seedImportedCount = 0

/** 由 seed.ts 在预置完成后调用，供 library:getSeedInfo 回报 */
export function markSeedApplied(count: number): void {
  seedAppliedThisRun = true
  seedImportedCount = count
}

// ---------- IPC 注册 ----------

export function registerLibraryIpc(): void {
  // 启动建库/迁移（连接、迁移策略都在 ./db 内）
  initDb()

  // 选择导入文件：多选；.doc 也放行（选中后给出可感知的转换提示，而非灰掉选不了）
  ipcMain.handle('dialog:pickImportFiles', async (): Promise<PickFilesResult> => {
    const options = {
      title: '选择要导入的文档',
      properties: ['openFile', 'multiSelections'] as Array<
        'openFile' | 'multiSelections'
      >,
      filters: [{ name: '法律文档（docx/pdf/txt/doc）', extensions: ['docx', 'pdf', 'txt', 'doc'] }]
    }
    const win = BrowserWindow.getFocusedWindow()
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return { canceled: result.canceled, paths: result.filePaths }
  })

  // 文档列表（最新在前）
  ipcMain.handle('library:listDocuments', (): DocumentRow[] => {
    return getDb().prepare('SELECT * FROM documents ORDER BY id DESC').all() as unknown as DocumentRow[]
  })

  // 文档详情：文档全字段 + 法条（按 order_index）+ 段落（按 seq）
  ipcMain.handle('library:getDocument', (_e, id: number): DocumentDetail => {
    const db = getDb()
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(id) as
      | DocumentRow
      | undefined
    if (!doc) throw new Error('文档不存在')
    const articles = db
      .prepare('SELECT * FROM articles WHERE document_id=? ORDER BY order_index')
      .all(id) as unknown as ArticleRow[]
    const chunks = db
      .prepare('SELECT * FROM chunks WHERE document_id=? ORDER BY seq')
      .all(id) as unknown as ChunkRow[]
    return { ...doc, articles, chunks }
  })

  // 删除文档：FTS 行不随外键级联，必须先按子查询手动删，再删 articles/chunks/documents
  ipcMain.handle('library:deleteDocument', (_e, id: number): void => {
    const db = getDb()
    const doc = db.prepare('SELECT id FROM documents WHERE id=?').get(id)
    if (!doc) throw new Error('文档不存在')
    withTransaction(db, () => {
      db.prepare(
        'DELETE FROM articles_fts WHERE article_id IN (SELECT id FROM articles WHERE document_id=?)'
      ).run(id)
      db.prepare(
        'DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?)'
      ).run(id)
      db.prepare('DELETE FROM articles WHERE document_id=?').run(id)
      db.prepare('DELETE FROM chunks WHERE document_id=?').run(id)
      db.prepare('DELETE FROM documents WHERE id=?').run(id)
    })
  })

  // 状态切换：仅允许 parsed / needs_review（解析校对流程用）
  ipcMain.handle('library:setDocumentStatus', (_e, id: number, status: DocStatus): void => {
    if (status !== 'parsed' && status !== 'needs_review') {
      throw new Error('status 仅支持 parsed / needs_review')
    }
    const db = getDb()
    const info = db.prepare('UPDATE documents SET status=? WHERE id=?').run(status, id)
    if (Number(info.changes) === 0) throw new Error('文档不存在')
  })

  // 批量导入：逐文件顺序处理，单文件失败不阻断批量；typeChoice 校验白名单（缺省 auto 兼容旧调用）
  ipcMain.handle(
    'library:importDocuments',
    async (
      _e,
      paths: string[],
      category: string,
      typeChoice: ImportTypeChoice
    ): Promise<ImportResultItem[]> => {
      const list = Array.isArray(paths) ? paths : []
      const cat = typeof category === 'string' ? category : ''
      const choice: ImportTypeChoice = (
        ['auto', 'statute', 'case', 'book', 'other'] as const
      ).includes(typeChoice)
        ? typeChoice
        : 'auto'
      return importFiles(list, cat, choice)
    }
  )

  // 首次启动预置法条的结果查询（渲染层用于展示一次性提示）
  ipcMain.handle('library:getSeedInfo', (): { justApplied: boolean; count: number } => {
    return { justApplied: seedAppliedThisRun, count: seedImportedCount }
  })

  // 把文档归入 / 移出分类文件夹（category 冗余副本同步）
  ipcMain.handle('library:setDocumentGroup', (_e, documentId: number, groupId: number | null): void => {
    const db = getDb()
    const doc = db.prepare('SELECT id FROM documents WHERE id=?').get(Number(documentId))
    if (doc === undefined) throw new Error('文档不存在')
    if (groupId === null) {
      db.prepare("UPDATE documents SET group_id=NULL, category='' WHERE id=?").run(Number(documentId))
      return
    }
    const group = db.prepare('SELECT id, name FROM doc_groups WHERE id=?').get(Number(groupId)) as
      | { id: number; name: string }
      | undefined
    if (!group) throw new Error('分类文件夹不存在')
    db.prepare('UPDATE documents SET group_id=?, category=? WHERE id=?').run(
      Number(groupId),
      String(group.name),
      Number(documentId)
    )
  })

  // 法条详情：条文全文 + 文档名/分类 + 同文档前后条（阅读器翻页用）
  ipcMain.handle('library:getArticle', (_e, id: number): ArticleDetail => {
    const db = getDb()
    const article = db
      .prepare(
        'SELECT a.*, d.title, d.category FROM articles a JOIN documents d ON d.id = a.document_id WHERE a.id=?'
      )
      .get(id) as unknown as ArticleRow | undefined
    if (!article) throw new Error('条文不存在')
    const neighbor = (
      sql: string
    ): ArticleNeighbors | null => {
      const row = db.prepare(sql).get(article.document_id, article.order_index) as
        | { id: number; article_label: string }
        | undefined
      return row ? { id: Number(row.id), label: String(row.article_label) } : null
    }
    return {
      article,
      prev: neighbor(
        'SELECT id, article_label FROM articles WHERE document_id=? AND order_index<? ORDER BY order_index DESC LIMIT 1'
      ),
      next: neighbor(
        'SELECT id, article_label FROM articles WHERE document_id=? AND order_index>? ORDER BY order_index ASC LIMIT 1'
      )
    }
  })

  // 条文修正：保存并重建该条的 FTS 索引行（删旧行 → 重插切词后文本）
  ipcMain.handle('library:updateArticle', (_e, id: number, rawContent: string): void => {
    const content = String(rawContent ?? '').trim()
    if (!content) throw new Error('内容为空')
    const db = getDb()
    withTransaction(db, () => {
      const info = db.prepare('UPDATE articles SET content=? WHERE id=?').run(content, id)
      if (Number(info.changes) === 0) throw new Error('条文不存在')
      db.prepare('DELETE FROM articles_fts WHERE article_id=?').run(id)
      db.prepare('INSERT INTO articles_fts(article_id, content) VALUES(?,?)').run(
        id,
        tokenize(content)
      )
    })
  })
}
