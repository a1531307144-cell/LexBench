// 笔记导出（阶段2）：大纲树 → Markdown / docx 段落结构
// 纯函数层（vitest 可直测）：树降级为嵌套列表；引用节点（ref）导出为《法规》第X条 + 正文子行。

import type { OutlineNode } from './types'

/** 扁平段落：缩进层级 + 文本（docx 直接按此生成；md 按层级补 '-'） */
export interface OutlineFlatLine {
  depth: number
  text: string
  /** 引用节点行（导出时可加重号/样式区分） */
  isRef: boolean
}

/**
 * 树拍平为带层级的行列表（与编辑器渲染同一形态语义）。
 * 折叠态不影响导出——导出永远是全量内容。
 */
export function flattenOutline(nodes: OutlineNode[], depth = 0, out: OutlineFlatLine[] = []): OutlineFlatLine[] {
  for (const n of nodes) {
    out.push({ depth, text: n.text, isRef: !!n.ref })
    flattenOutline(n.children ?? [], depth + 1, out)
  }
  return out
}

/** 大纲树 → Markdown（无标题行；标题由调用方拼，避免重复） */
export function outlineToMarkdown(nodes: OutlineNode[]): string {
  const lines = flattenOutline(nodes)
  return lines
    .map((l) => {
      const indent = '  '.repeat(l.depth)
      const bullet = l.text ? '- ' : ''
      return `${indent}${bullet}${l.text}`
    })
    .join('\n')
}
