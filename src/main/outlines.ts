// 笔记库：大纲 CRUD IPC + 法条星标（阶段2数据层）
// - outlines 单表整树 JSON 落库（百级节点量级，不拆表）；树的校验/操作全在渲染层编辑器，
//   这里只保证「存的是合法 JSON 数组」这一底线；
// - 星标 = articles.starred（0/1），轻量临时收集，与笔记模型互不相干。

import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import { flattenOutline, outlineToMarkdown } from '../shared/outlineExport'
import { parseImportedFile, toOutlineNodes, type ImportedNode } from '../shared/outlineImport'
import type {
  ExportFormat,
  ExportResult,
  ImportPreviewItem,
  ImportRunItem,
  NoteGroupRow,
  OutlineListRow,
  OutlineNode,
  OutlineRef,
  OutlineRow,
  StarredArticleRow
} from '../shared/types'
import { getDb } from './db'

// ---------- 贴图存储：userData/attachments/（随数据包备份；节点内相对文件名引用） ----------

let attachmentsDir: string | null = null

function getAttachmentsDir(): string {
  if (!attachmentsDir) {
    attachmentsDir = join(app.getPath('userData'), 'attachments')
    mkdirSync(attachmentsDir, { recursive: true })
  }
  return attachmentsDir
}

/** 贴图入库：base64（无前缀）→ sha 摘要文件名去重落盘；返回相对文件名 */
function saveAttachmentImage(b64: string, ext: string): string {
  const cleanExt = /^\/?\.(png|jpe?g|gif|webp|bmp)$/i.exec(ext)?.[1]?.toLowerCase() ?? 'png'
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new Error('图片数据格式不正确')
  const buf = Buffer.from(b64.replace(/\s/g, ''), 'base64')
  if (buf.length === 0) throw new Error('图片数据为空')
  if (buf.length > 20 * 1024 * 1024) throw new Error('图片超过 20MB 上限')
  // 文件名 = 内容摘要（同图复用、防路径注入）
  const name = `${createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${cleanExt}`
  const full = join(getAttachmentsDir(), name)
  if (!existsSync(full)) writeFileSync(full, buf)
  return name
}

/** 贴图入库（字节流版：导入器下载的远程图片） */
function saveAttachmentBuffer(buf: Buffer, hintExt: string): string {
  if (buf.length === 0 || buf.length > 20 * 1024 * 1024) throw new Error('图片大小不合法')
  const cleanExt = /^\.?(png|jpe?g|gif|webp|bmp)$/i.exec(hintExt)?.[1]?.toLowerCase() ?? 'png'
  const name = `${createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${cleanExt}`
  const full = join(getAttachmentsDir(), name)
  if (!existsSync(full)) writeFileSync(full, buf)
  return name
}

// ---------- 导入辅助 ----------

function countImportedNodes(nodes: ImportedNode[]): number {
  let c = 0
  for (const n of nodes) {
    c += 1 + countImportedNodes(n.children)
  }
  return c
}

/** 同名笔记加 " (2)" 后缀（循环递增） */
function uniqueTitle(base: string): string {
  const db = getDb()
  let title = base
  let i = 1
  while (db.prepare('SELECT 1 FROM outlines WHERE title = ?').get(title)) {
    i += 1
    title = `${base} (${i})`
  }
  return title
}

/** 下载节点树内的贴图 URL → attachments 落盘；失败的图转为文本行保留 URL。返回失败数 */
async function downloadTreeImages(nodes: OutlineNode[]): Promise<number> {
  // 收集 {node, url}
  const targets: { node: OutlineNode; url: string }[] = []
  const walk = (ns: OutlineNode[]): void => {
    for (const n of ns) {
      if (n.image && /^https?:\/\//.test(n.image)) targets.push({ node: n, url: n.image })
      walk(n.children)
    }
  }
  walk(nodes)

  let failed = 0
  const queue = [...targets]
  const worker = async (): Promise<void> => {
    for (;;) {
      const t = queue.shift()
      if (!t) return
      try {
        const buf = await downloadImage(t.url)
        t.node.image = saveAttachmentBuffer(buf, extFromUrl(t.url))
      } catch {
        // 失败：URL 保留在文本行，不留悬空 image 字段
        t.node.text = [t.node.text, `![图片](${t.url})`].filter(Boolean).join(' ')
        delete t.node.image
        failed += 1
      }
    }
  }
  await Promise.all([worker(), worker()]) // 并发 2
  return failed
}

async function downloadImage(url: string): Promise<Buffer> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error('空图片')
      return buf
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('图片下载失败')
}

function extFromUrl(url: string): string {
  const m = /\.([a-zA-Z0-9]+)(?:[?#]|$)/.exec(url)
  return m?.[1] ?? 'png'
}

/** 树 JSON 底线校验：必须是节点数组（节点结构由渲染层负责） */
function parseTree(tree: string): OutlineNode[] {
  const parsed: unknown = JSON.parse(tree)
  if (!Array.isArray(parsed)) throw new Error('笔记树必须是节点数组')
  return parsed as OutlineNode[]
}

// ---------- 引用节点右键上下文（照批注 setActive 的既有模式） ----------
// 渲染层在引用行上按下右键时先送来 ref（DOM contextmenu 先于主进程 context-menu 事件，
// 同一 IPC 管道保序），主进程拼菜单时据此追加「在文档库打开来源」；菜单关闭即清。

let refContext: OutlineRef | null = null

export function getRefContext(): OutlineRef | null {
  return refContext
}

export function clearRefContext(): void {
  refContext = null
}

// ---------- 笔记导出（md / docx；承接原专题导出能力） ----------

/** Windows 文件名非法字符清洗（与读书笔记导出同规则） */
function safeFileName(name: string, ext: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/[.\s]+$/g, '').trim()
  return `${cleaned || '未命名笔记'}${ext}`
}

/** 生成笔记文件二进制：md → UTF-8 Buffer；docx → Packer.toBuffer（层级按缩进降级） */
async function generateOutlineFile(
  format: ExportFormat,
  title: string,
  tree: OutlineNode[]
): Promise<Buffer> {
  if (format === 'md') {
    return Buffer.from(`# ${title}\n\n${outlineToMarkdown(tree)}\n\n---\n\n*导出自 LexBench · 法研台*\n`, 'utf8')
  }
  if (format === 'docx') {
    const children: Paragraph[] = [new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 })]
    for (const line of flattenOutline(tree)) {
      if (!line.text.trim() && !line.note) continue
      const taskMark = line.task === 2 ? '☑ ' : line.task === 1 ? '☐ ' : ''
      if (line.text.trim()) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${'　'.repeat(line.depth)}${line.isRef ? '' : '· '}${taskMark}${line.text}`,
                bold: !!line.heading,
                size: line.heading ? 30 - line.heading * 2 : 24
              })
            ],
            spacing: { after: line.note ? 20 : 60 }
          })
        )
      }
      if (line.note) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${'　'.repeat(line.depth + 1)}${line.note.replace(/\r?\n/g, ' ')}`,
                italics: true,
                color: '666666',
                size: 20
              })
            ],
            spacing: { after: 60 }
          })
        )
      }
    }
    const doc = new Document({
      styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
      sections: [{ children }]
    })
    return Packer.toBuffer(doc)
  }
  throw new Error(`不支持的导出格式：${String(format)}`)
}

export function registerOutlinesIpc(): void {
  // 贴图：保存（Ctrl+V/拖入 → base64 → attachments 落盘，返回文件名）
  ipcMain.handle('attachments:saveImage', (_e, b64: string, ext: string): string => {
    return saveAttachmentImage(String(b64 ?? ''), String(ext ?? ''))
  })

  // 贴图读取：文件名（不含路径）→ 字节流；路径穿越在此拦截
  ipcMain.handle('attachments:read', (_e, fileName: string): Buffer => {
    const safe = String(fileName ?? '')
    if (!/^[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp|bmp)$/i.test(safe)) throw new Error('非法附件名')
    const full = join(getAttachmentsDir(), safe)
    if (!existsSync(full)) throw new Error('附件不存在')
    return readFileSync(full)
  })

  // 引用行右键：渲染层先报 ref，主进程菜单据此追加「在文档库打开来源」
  ipcMain.on('outlines:setRefContext', (_e, ref: OutlineRef | null) => {
    refContext =
      ref && Number.isFinite(ref.docId) && Number.isFinite(ref.articleId)
        ? { docId: Number(ref.docId), articleId: Number(ref.articleId) }
        : null
  })

  // 笔记列表（更新时间序；列表页不带 tree，轻载；groupId 过滤分类列）
  ipcMain.handle(
    'outlines:list',
    (_e, keyword?: string, groupId?: number | null): OutlineListRow[] => {
      const kw = typeof keyword === 'string' ? keyword.trim() : ''
      const db = getDb()
      const where: string[] = []
      const args: (string | number)[] = []
      if (kw) {
        // LIKE 够用（列表搜索先不做 FTS，见设计稿 §7）
        where.push(`title LIKE ? ESCAPE '\\'`)
        args.push(`%${kw.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)
      }
      if (groupId !== undefined && groupId !== null) {
        where.push('group_id = ?')
        args.push(groupId)
      } else if (groupId === null) {
        where.push('group_id IS NULL')
      }
      const sql = `SELECT id, title, group_id, updated_at FROM outlines${
        where.length ? ' WHERE ' + where.join(' AND ') : ''
      } ORDER BY updated_at DESC`
      return db.prepare(sql).all(...args) as unknown as OutlineListRow[]
    }
  )

  // 打开一篇笔记（编辑器拉全树）
  ipcMain.handle('outlines:get', (_e, id: number): OutlineRow => {
    const row = getDb().prepare('SELECT * FROM outlines WHERE id = ?').get(id) as
      | OutlineRow
      | undefined
    if (!row) throw new Error('笔记不存在')
    return row
  })

  // 新建笔记（空树起步，编辑器首行兜底；可直接落到某分类）
  ipcMain.handle('outlines:create', (_e, title: string, groupId?: number | null): OutlineRow => {
    const info = getDb()
      .prepare('INSERT INTO outlines(title, tree, group_id) VALUES(?, ?, ?)')
      .run(title.trim() || '未命名笔记', '[]', groupId ?? null)
    const row = getDb()
      .prepare('SELECT * FROM outlines WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as OutlineRow | undefined
    if (!row) throw new Error('笔记创建失败')
    return row
  })

  // 笔记归类 / 记住视图（独立口：树的自动保存不带这些字段，避免互相覆盖）
  ipcMain.handle('outlines:setGroup', (_e, id: number, groupId: number | null): void => {
    const info = getDb().prepare('UPDATE outlines SET group_id = ? WHERE id = ?').run(groupId, id)
    if (Number(info.changes) === 0) throw new Error('笔记不存在')
  })

  ipcMain.handle('outlines:setViewMode', (_e, id: number, mode: string): void => {
    const m = mode === 'map' ? 'map' : 'outline'
    const info = getDb().prepare('UPDATE outlines SET view_mode = ? WHERE id = ?').run(m, id)
    if (Number(info.changes) === 0) throw new Error('笔记不存在')
  })

  // ---------- 笔记自定义分类（note_groups；配方对齐文档库分类） ----------

  ipcMain.handle('noteGroups:list', (): NoteGroupRow[] => {
    return getDb()
      .prepare(
        `SELECT g.id, g.name, g.sort_order,
                (SELECT COUNT(*) FROM outlines o WHERE o.group_id = g.id) AS note_count
           FROM note_groups g ORDER BY g.sort_order, g.id`
      )
      .all() as unknown as NoteGroupRow[]
  })

  ipcMain.handle('noteGroups:create', (_e, name: string): NoteGroupRow => {
    const db = getDb()
    const trimmed = String(name ?? '').trim()
    if (!trimmed) throw new Error('分类名不能为空')
    const dup = db.prepare('SELECT 1 FROM note_groups WHERE name = ?').get(trimmed)
    if (dup) throw new Error('同名分类已存在')
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM note_groups').get() as {
      m: number
    }
    const info = db
      .prepare('INSERT INTO note_groups(name, sort_order) VALUES(?, ?)')
      .run(trimmed, Number(max.m) + 1)
    return { id: Number(info.lastInsertRowid), name: trimmed, sort_order: Number(max.m) + 1, note_count: 0 }
  })

  ipcMain.handle('noteGroups:rename', (_e, id: number, name: string): void => {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) throw new Error('分类名不能为空')
    const dup = getDb().prepare('SELECT 1 FROM note_groups WHERE name = ? AND id != ?').get(trimmed, id)
    if (dup) throw new Error('同名分类已存在')
    const info = getDb().prepare('UPDATE note_groups SET name = ? WHERE id = ?').run(trimmed, id)
    if (Number(info.changes) === 0) throw new Error('分类不存在')
  })

  // 拖动排序：按传入 id 顺序整体重排（同 groups:reorder 配方）
  ipcMain.handle('noteGroups:reorder', (_e, ids: number[]): void => {
    const db = getDb()
    db.exec('BEGIN')
    try {
      const stmt = db.prepare('UPDATE note_groups SET sort_order = ? WHERE id = ?')
      ids.forEach((id, i) => stmt.run(i + 1, id))
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  })

  // 删除分类：其中笔记归「未分类」（group_id ON DELETE SET NULL 语义由显式 UPDATE 兜底，
  // 因为这里删的是 note_groups 行、outlines.group_id 是引用列——SQLite 外键若未开则显式清）
  ipcMain.handle('noteGroups:remove', (_e, id: number): void => {
    const db = getDb()
    db.exec('BEGIN')
    try {
      db.prepare('UPDATE outlines SET group_id = NULL WHERE group_id = ?').run(id)
      const info = db.prepare('DELETE FROM note_groups WHERE id = ?').run(id)
      if (Number(info.changes) === 0) throw new Error('分类不存在')
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  })

  // 自动保存（编辑器防抖 500ms 整树落库）；title 可选（重命名走同一口）
  ipcMain.handle('outlines:save', (_e, id: number, tree: string, title?: string): void => {
    parseTree(tree) // 非法 JSON 直接抛给渲染层错误条，不落库
    const db = getDb()
    const info =
      title === undefined
        ? db
            .prepare(
              "UPDATE outlines SET tree = ?, updated_at = datetime('now','localtime') WHERE id = ?"
            )
            .run(tree, id)
        : db
            .prepare(
              "UPDATE outlines SET tree = ?, title = ?, updated_at = datetime('now','localtime') WHERE id = ?"
            )
            .run(tree, title.trim() || '未命名笔记', id)
    if (Number(info.changes) === 0) throw new Error('笔记不存在')
  })

  ipcMain.handle('outlines:delete', (_e, id: number): void => {
    const info = getDb().prepare('DELETE FROM outlines WHERE id = ?').run(id)
    if (Number(info.changes) === 0) throw new Error('笔记不存在')
  })

  // 导出笔记：保存对话框 → 生成 md/docx → 写盘；取消返回 {canceled:true}
  ipcMain.handle(
    'outlines:export',
    async (_e, id: number, format: ExportFormat): Promise<ExportResult> => {
      if (format !== 'md' && format !== 'docx') {
        throw new Error(`不支持的导出格式：${String(format)}`)
      }
      const row = getDb().prepare('SELECT * FROM outlines WHERE id = ?').get(Number(id)) as
        | OutlineRow
        | undefined
      if (!row) throw new Error('笔记不存在')
      const ext = format === 'docx' ? '.docx' : '.md'
      const options = {
        title: '导出笔记',
        defaultPath: safeFileName(row.title, ext),
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
      const buffer = await generateOutlineFile(format, row.title, parseTree(row.tree))
      let filePath = result.filePath
      if (!filePath.toLowerCase().endsWith(ext)) filePath += ext
      writeFileSync(filePath, buffer)
      return { canceled: false, path: filePath }
    }
  )

  // 自测专用：跳过对话框按给定路径直接写盘（仅开发模式注册）
  if (!app.isPackaged) {
    ipcMain.handle(
      'outlines:__testExport',
      async (_e, id: number, format: ExportFormat, outPath: string): Promise<ExportResult> => {
        const row = getDb().prepare('SELECT * FROM outlines WHERE id = ?').get(Number(id)) as
          | OutlineRow
          | undefined
        if (!row) throw new Error('笔记不存在')
        const buffer = await generateOutlineFile(format, row.title, parseTree(row.tree))
        writeFileSync(outPath, buffer)
        return { canceled: false, path: outPath }
      }
    )
  }

  // ---------- 通用大纲导入（阶段3：OPML / HTML / Markdown，业界通用格式） ----------

  // 选文件（系统对话框，多选；业界通用大纲格式白名单）
  ipcMain.handle(
    'outlines:pickImportFiles',
    async (): Promise<{ canceled: boolean; paths: string[] }> => {
      const options: OpenDialogOptions = {
        title: '导入大纲笔记',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '大纲文件', extensions: ['opml', 'html', 'htm', 'md', 'markdown'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      }
      const win = BrowserWindow.getFocusedWindow()
      const r = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return { canceled: r.canceled, paths: r.filePaths }
    }
  )

  // 预检：解析展示用（不落库、不下载图片）；逐篇给标题/格式/节点数/图片数/是否重复
  ipcMain.handle('outlines:previewImport', (_e, paths: string[]): ImportPreviewItem[] => {
    const db = getDb()
    return (Array.isArray(paths) ? paths : []).map((p) => {
      const name = p.split(/[\\/]/).pop() ?? p
      try {
        const content = readFileSync(p, 'utf8')
        const sourceKey = createHash('sha1').update(content).digest('hex')
        const doc = parseImportedFile(name, content, () => '')
        const dup = !!db.prepare('SELECT 1 FROM outlines WHERE source_key = ?').get(sourceKey)
        return {
          path: p,
          name,
          title: doc.title,
          format: doc.format,
          nodeCount: countImportedNodes(doc.nodes),
          imageCount: doc.imageCount,
          duplicate: dup
        }
      } catch (err) {
        return {
          path: p,
          name,
          title: '',
          format: '',
          nodeCount: 0,
          imageCount: 0,
          duplicate: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    })
  })

  // 执行导入：解析 → 图片下载落盘 → 事务入库；duplicates=重复时 'skip'跳过 / 'append'仍然导入
  ipcMain.handle(
    'outlines:runImport',
    async (_e, paths: string[], duplicates: string): Promise<ImportRunItem[]> => {
      const db = getDb()
      const policy = duplicates === 'append' ? 'append' : 'skip'
      const results: ImportRunItem[] = []
      for (const p of Array.isArray(paths) ? paths : []) {
        const name = p.split(/[\\/]/).pop() ?? p
        try {
          const content = readFileSync(p, 'utf8')
          const sourceKey = createHash('sha1').update(content).digest('hex')
          const doc = parseImportedFile(name, content, () =>
            `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
          )
          const existing = db
            .prepare('SELECT id FROM outlines WHERE source_key = ?')
            .get(sourceKey) as { id: number } | undefined
          if (existing && policy === 'skip') {
            results.push({ path: p, status: 'skipped', message: '已导入过（同源文件）' })
            continue
          }
          const tree = toOutlineNodes(doc.nodes, () =>
            `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
          )
          // 图片下载：并发 2、单张 10s、重试 1；失败保留 URL（转文本行），不阻断本篇
          const imagesFailed = await downloadTreeImages(tree)
          const title = uniqueTitle(doc.title || name.replace(/\.[^.]+$/, ''))
          db.exec('BEGIN')
          try {
            if (existing) db.prepare('DELETE FROM outlines WHERE id = ?').run(existing.id)
            db.prepare('INSERT INTO outlines(title, tree, source_key) VALUES(?, ?, ?)').run(
              title,
              JSON.stringify(tree),
              sourceKey
            )
            db.exec('COMMIT')
          } catch (err) {
            db.exec('ROLLBACK')
            throw err
          }
          results.push({ path: p, status: existing ? 'replaced' : 'imported', imagesFailed })
        } catch (err) {
          results.push({
            path: p,
            status: 'failed',
            message: err instanceof Error ? err.message : String(err)
          })
        }
      }
      return results
    }
  )

  // ---- 星标（articles.starred）----

  // 点亮/熄灭星标
  ipcMain.handle('articles:setStarred', (_e, articleId: number, starred: boolean): void => {
    const info = getDb()
      .prepare('UPDATE articles SET starred = ? WHERE id = ?')
      .run(starred ? 1 : 0, articleId)
    if (Number(info.changes) === 0) throw new Error('法条不存在')
  })

  // 星标列表（笔记库左列入口；带所属文档标题供展示与跳转）
  ipcMain.handle('articles:listStarred', (): StarredArticleRow[] => {
    return getDb()
      .prepare(
        `SELECT a.id AS article_id, a.document_id, a.article_label, d.title AS doc_title,
                a.order_index
           FROM articles a
           JOIN documents d ON d.id = a.document_id
          WHERE a.starred = 1
          ORDER BY d.title, a.order_index`
      )
      .all() as unknown as StarredArticleRow[]
  })
}
