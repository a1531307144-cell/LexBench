// 平行视图存档 IPC：一篇笔记唯一一份布局（note_id UNIQUE）。
// 布局是渲染层产出的 JSON；写入前在这里做严格校验，坏数据直接拒绝，不给库留脏。
// 删除笔记由 parallel_views.note_id 的 ON DELETE CASCADE 负责清理（initDb 已开 foreign_keys）。

import { ipcMain } from 'electron'
import {
  createDefaultLayout,
  serializeParallelLayout,
  validateParallelLayout
} from '../shared/parallelLayout'
import type { ParallelViewListRow, ParallelViewRow } from '../shared/types'
import { getDb } from './db'

function asNoteId(v: unknown): number {
  const id = Math.floor(Number(v))
  if (!Number.isFinite(id) || id <= 0) throw new Error('笔记 id 不正确')
  return id
}

function getRow(noteId: number): ParallelViewRow | null {
  const row = getDb().prepare('SELECT * FROM parallel_views WHERE note_id = ?').get(noteId) as
    | ParallelViewRow
    | undefined
  return row ?? null
}

export function registerParallelViewsIpc(): void {
  // 列表以笔记为主表：每篇笔记一行，没有存档的笔记也显示（打开时再落默认布局）。
  // 这样「平行视图数量 = 笔记数量」，一一对应，不会出现笔记有、视图列表没有的断层。
  ipcMain.handle('parallelViews:list', (): ParallelViewListRow[] => {
    const rows = getDb()
      .prepare(
        `SELECT p.id, o.id AS note_id, o.title AS note_title,
                COALESCE(p.name, '') AS name,
                COALESCE(p.updated_at, o.updated_at) AS updated_at,
                p.layout
         FROM outlines o
         LEFT JOIN parallel_views p ON p.note_id = o.id
         ORDER BY COALESCE(p.updated_at, o.updated_at) DESC, o.id DESC`
      )
      .all() as unknown as Array<{
      id: number | null
      note_id: number
      note_title: string
      name: string
      updated_at: string
      layout: string | null
    }>
    return rows.map((r) => {
      let docCount = 0
      if (r.layout) {
        try {
          const parsed = JSON.parse(r.layout) as { panes?: Array<{ kind?: string }> }
          docCount = Array.isArray(parsed.panes)
            ? parsed.panes.filter((p) => p.kind === 'doc').length
            : 0
        } catch {
          docCount = 0
        }
      }
      return {
        id: r.id,
        note_id: r.note_id,
        note_title: r.note_title,
        name: r.name,
        updated_at: r.updated_at,
        doc_count: docCount
      }
    })
  })

  ipcMain.handle('parallelViews:get', (_e, noteId: unknown): ParallelViewRow | null => {
    return getRow(asNoteId(noteId))
  })

  ipcMain.handle(
    'parallelViews:save',
    (_e, noteId: unknown, layout: unknown, name?: unknown): ParallelViewRow => {
      const id = asNoteId(noteId)
      const db = getDb()
      if (!db.prepare('SELECT 1 FROM outlines WHERE id = ?').get(id)) throw new Error('笔记不存在')
      let parsed: unknown = layout
      if (typeof layout === 'string') {
        try {
          parsed = JSON.parse(layout)
        } catch {
          throw new Error('并行布局数据格式不正确')
        }
      }
      const normalized = JSON.stringify(validateParallelLayout(parsed))
      const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : ''

      db.prepare(
        `INSERT INTO parallel_views (note_id, name, layout)
         VALUES (?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET
           layout = excluded.layout,
           name = CASE WHEN excluded.name = '' THEN parallel_views.name ELSE excluded.name END,
           updated_at = datetime('now','localtime')`
      ).run(id, cleanName, normalized)

      const saved = getRow(id)
      if (!saved) throw new Error('并行视图保存失败')
      return saved
    }
  )

  ipcMain.handle('parallelViews:rename', (_e, noteId: unknown, name: unknown): void => {
    const id = asNoteId(noteId)
    const db = getDb()
    if (!db.prepare('SELECT 1 FROM outlines WHERE id = ?').get(id)) throw new Error('笔记不存在')
    const clean = typeof name === 'string' ? name.trim().slice(0, 80) : ''
    const info = db
      .prepare("UPDATE parallel_views SET name = ?, updated_at = datetime('now','localtime') WHERE note_id = ?")
      .run(clean, id)
    if (Number(info.changes) === 0) {
      // 从未打开过的笔记也允许先改名：顺手落一份默认布局
      db.prepare('INSERT INTO parallel_views (note_id, name, layout) VALUES (?, ?, ?)').run(
        id,
        clean,
        serializeParallelLayout(createDefaultLayout())
      )
    }
  })

  // 重置布局但保留自定义名称：一一对应后不再提供「删除存档」（删笔记才删除视图）
  ipcMain.handle('parallelViews:reset', (_e, noteId: unknown): void => {
    const id = asNoteId(noteId)
    const db = getDb()
    if (!db.prepare('SELECT 1 FROM outlines WHERE id = ?').get(id)) throw new Error('笔记不存在')
    const info = db
      .prepare("UPDATE parallel_views SET layout = ?, updated_at = datetime('now','localtime') WHERE note_id = ?")
      .run(serializeParallelLayout(createDefaultLayout()), id)
    if (Number(info.changes) === 0) {
      // 没有存档行本来就是默认布局，无需插入
    }
  })

}
