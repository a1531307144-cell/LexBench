// 法条批注：CRUD IPC + 右键菜单上下文开关
// 锚点 = article_id + content 字符起止偏移（渲染层据 offset 恢复高亮与 ★）；
// 高亮渲染/选区偏移计算都在渲染层，这里只管存取与「当前能否添加批注」的全局开关
// （开关由 StatuteReadingView 挂载/卸载时设置——右键菜单在主进程拼，需要知道渲染层上下文）。

import { ipcMain } from 'electron'
import type { AnnotationRow } from '../shared/types'
import { getDb } from './db'

/** 当前活动阅读页是否开启批注（true 时右键菜单出现「添加批注」） */
let annotationContextActive = false

export function isAnnotationContextActive(): boolean {
  return annotationContextActive
}

/** 批注列表项：批注行 + 所属条文的 order_index（渲染时按位置归位） */
export type AnnotationWithOrder = AnnotationRow & { order_index: number }

export function registerAnnotationsIpc(): void {
  // 渲染层告知上下文开关（阅读页挂载 true / 卸载 false）
  ipcMain.on('annotations:setActive', (_e, active: boolean) => {
    annotationContextActive = !!active
  })

  // 按文档列出全部批注（打开阅读页一次拉全，按条文顺序+起点排序）
  ipcMain.handle('annotations:listByDoc', (_e, documentId: number): AnnotationWithOrder[] => {
    return getDb()
      .prepare(
        `SELECT an.id, an.article_id, an.quote, an.start_offset, an.end_offset,
                an.content_md, an.created_at, an.updated_at, a.order_index
           FROM statute_annotations an
           JOIN articles a ON a.id = an.article_id
          WHERE a.document_id = ?
          ORDER BY a.order_index, an.start_offset`
      )
      .all(documentId) as unknown as AnnotationWithOrder[]
  })

  // 新建批注（校验法条存在；空内容也允许——浮窗交互上空内容不落库，这里不重复约束）
  ipcMain.handle(
    'annotations:create',
    (
      _e,
      payload: {
        articleId: number
        quote: string
        startOffset: number
        endOffset: number
        contentMd: string
      }
    ): AnnotationRow => {
      const db = getDb()
      const exists = db
        .prepare('SELECT 1 FROM articles WHERE id = ?')
        .get(payload.articleId)
      if (!exists) throw new Error('法条不存在')
      const info = db
        .prepare(
          'INSERT INTO statute_annotations(article_id, quote, start_offset, end_offset, content_md) VALUES(?,?,?,?,?)'
        )
        .run(
          payload.articleId,
          payload.quote,
          payload.startOffset,
          payload.endOffset,
          payload.contentMd
        )
      const row = db
        .prepare('SELECT * FROM statute_annotations WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as unknown as AnnotationRow
      if (!row) throw new Error('批注创建失败')
      return row
    }
  )

  // 更新批注内容（锚点不可变）
  ipcMain.handle('annotations:update', (_e, id: number, contentMd: string): void => {
    const info = getDb()
      .prepare(
        "UPDATE statute_annotations SET content_md = ?, updated_at = datetime('now','localtime') WHERE id = ?"
      )
      .run(contentMd, id)
    if (Number(info.changes) === 0) throw new Error('批注不存在')
  })

  ipcMain.handle('annotations:delete', (_e, id: number): void => {
    const info = getDb()
      .prepare('DELETE FROM statute_annotations WHERE id = ?')
      .run(id)
    if (Number(info.changes) === 0) throw new Error('批注不存在')
  })
}
