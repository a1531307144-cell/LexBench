// 法规目录推导：从 articles 的 编/章/节 戳记还原可点击的目录结构
// 数据在切分时已随导入保存（splitter.ts 把标题全文盖到每条上），这里只做纯推导，不改切分行为

export type StatuteTocLevel = 'branch' | 'chapter' | 'section'

export interface StatuteTocEntry {
  level: StatuteTocLevel
  /** 完整标题原文，如 "第一章　总则" */
  title: string
  /** 该标题下第一条条文的 order_index —— 跳转锚点 */
  orderIndex: number
}

/** buildStatuteToc 所需的条文字段（与 articles 表列一一对应） */
export interface StatuteHeadingFields {
  branch: string
  chapter: string
  section: string
  order_index: number
}

const LEVELS: StatuteTocLevel[] = ['branch', 'chapter', 'section']

/**
 * 从按 order_index 升序的条文列表推导目录（getDocument 已保证有序）。
 * 逐条比较三层戳记：变了且非空才发条目——连续相同戳记天然去重，
 * 空串表示被高级层清空（新编清章/节、新章清节），等真正的标题行到来时再发。
 * 平铺法规（无编/章/节）返回 []。
 */
export function buildStatuteToc(articles: readonly StatuteHeadingFields[]): StatuteTocEntry[] {
  const toc: StatuteTocEntry[] = []
  let prev: StatuteHeadingFields | null = null
  for (const a of articles) {
    for (const level of LEVELS) {
      const title = a[level]
      if (!title) continue
      if (prev !== null && prev[level] === title) continue
      toc.push({ level, title, orderIndex: a.order_index })
    }
    prev = a
  }
  return toc
}
