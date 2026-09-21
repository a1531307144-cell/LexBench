// 分类文件夹（用户自建）：每个文档类型下各自一套，可按需增删改
// 语义：同类型下不允许重名；删除文件夹时其中文档移入「未分类」（不随之删除）；
//       导入文档时由 library.ts 的 resolveGroupId 按名称自动找组/建组。

import { ipcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { DocGroupRow, DocType } from '../shared/types'
import { getDb } from './db'

/** node:sqlite 原始行 → DocGroupRow（数值列统一 Number 收窄） */
function toGroupRow(row: Record<string, unknown>): DocGroupRow {
  return {
    id: Number(row['id']),
    doc_type: String(row['doc_type']) as DocType,
    name: String(row['name']),
    created_at: String(row['created_at']),
    doc_count: Number(row['doc_count'] ?? 0)
  }
}

/** 分组存在性校验 */
function requireGroup(db: DatabaseSync, id: number): void {
  const row = db.prepare('SELECT id FROM doc_groups WHERE id=?').get(id)
  if (row === undefined) throw new Error('分类文件夹不存在')
}

/** 名称为空或同类型下重名时拒绝（改名时排除自身） */
function assertNameUsable(db: DatabaseSync, docType: string, name: string, exceptId?: number): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) throw new Error('分类名称不能为空')
  const dup = exceptId
    ? db
        .prepare('SELECT id FROM doc_groups WHERE doc_type=? AND name=? AND id<>?')
        .get(docType, trimmed, exceptId)
    : db.prepare('SELECT id FROM doc_groups WHERE doc_type=? AND name=?').get(docType, trimmed)
  if (dup !== undefined) throw new Error('已存在同名分类')
  return trimmed
}

export function registerGroupsIpc(): void {
  // 列表：按类型过滤（不传为全部），带各文件夹文档数；按用户拖动排序（sort_order）返回
  ipcMain.handle('groups:list', (_e, docType?: DocType): DocGroupRow[] => {
    const db = getDb()
    const sql =
      'SELECT g.*, (SELECT COUNT(*) FROM documents d WHERE d.group_id = g.id) AS doc_count FROM doc_groups g' +
      (docType ? ' WHERE g.doc_type=?' : '') +
      ' ORDER BY g.sort_order, g.id'
    const rows = (docType ? db.prepare(sql).all(docType) : db.prepare(sql).all()) as unknown as Array<
      Record<string, unknown>
    >
    return rows.map(toGroupRow)
  })

  // 新建：名称为空 / 重名拒绝
  ipcMain.handle('groups:create', (_e, docType: DocType, name: string): DocGroupRow => {
    const db = getDb()
    const trimmed = assertNameUsable(db, String(docType), name)
    const info = db.prepare('INSERT INTO doc_groups(doc_type, name) VALUES(?,?)').run(String(docType), trimmed)
    const row = db.prepare('SELECT id, doc_type, name, created_at, 0 AS doc_count FROM doc_groups WHERE id=?').get(
      Number(info.lastInsertRowid)
    ) as Record<string, unknown>
    return toGroupRow(row)
  })

  // 改名：同类型下查重（排除自身）；文档随组走（documents.category 冗余副本同步更新）
  ipcMain.handle('groups:rename', (_e, id: number, name: string): void => {
    const db = getDb()
    const groupId = Number(id)
    const cur = db.prepare('SELECT doc_type, name FROM doc_groups WHERE id=?').get(groupId) as
      | { doc_type: string; name: string }
      | undefined
    if (!cur) throw new Error('分类文件夹不存在')
    const oldName = String(cur.name)
    const trimmed = assertNameUsable(db, String(cur.doc_type), name, groupId)
    db.exec('BEGIN')
    try {
      db.prepare('UPDATE doc_groups SET name=? WHERE id=?').run(trimmed, groupId)
      db.prepare('UPDATE documents SET category=? WHERE group_id=?').run(trimmed, groupId)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    void oldName
  })

  // 拖动排序：按传入的 id 顺序重写 sort_order（只影响同一类型下的展示顺序）
  ipcMain.handle('groups:reorder', (_e, ids: number[]): void => {
    const db = getDb()
    const list = Array.isArray(ids) ? ids.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : []
    if (list.length === 0) return
    const stmt = db.prepare('UPDATE doc_groups SET sort_order=? WHERE id=?')
    db.exec('BEGIN')
    try {
      list.forEach((gid, index) => stmt.run(index, gid))
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  })

  // 删除：其中文档移入「未分类」（group_id 置空、category 同步清空），文档本身保留
  ipcMain.handle('groups:remove', (_e, id: number): void => {
    const db = getDb()
    const groupId = Number(id)
    requireGroup(db, groupId)
    db.exec('BEGIN')
    try {
      db.prepare("UPDATE documents SET group_id=NULL, category='' WHERE group_id=?").run(groupId)
      db.prepare('DELETE FROM doc_groups WHERE id=?').run(groupId)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  })
}
