// 笔记导出（阶段2）：大纲树 → Markdown / docx 段落结构
// 纯函数层（vitest 可直测）：树降级为嵌套列表。

import { nodeMarkdownText } from './outlineRichText'
import type { OutlineNode } from './types'

/** 扁平段落：缩进层级 + 文本（docx 直接按此生成；md 按层级补 '-'） */
export interface OutlineFlatLine {
  depth: number
  text: string
  /** 行内富文本降级后的 Markdown（无格式时同 text） */
  markdownText: string
  /** 行下备注（导出为缩进的引用行） */
  note?: string
  heading?: 1 | 2 | 3
  /** 1=待办 2=已完成 */
  task?: 1 | 2
}

/**
 * 树拍平为带层级的行列表（与编辑器渲染同一形态语义）。
 * 折叠态不影响导出——导出永远是全量内容。
 */
export function flattenOutline(nodes: OutlineNode[], depth = 0, out: OutlineFlatLine[] = []): OutlineFlatLine[] {
  for (const n of nodes) {
    const line: OutlineFlatLine = {
      depth,
      text: n.text,
      markdownText: nodeMarkdownText(n)
    }
    if (n.note) line.note = n.note
    if (n.heading) line.heading = n.heading
    if (n.task) line.task = n.task
    out.push(line)
    flattenOutline(n.children ?? [], depth + 1, out)
  }
  return out
}

function taskPrefix(task: 1 | 2 | undefined): string {
  if (task === 2) return '[x] '
  if (task === 1) return '[ ] '
  return ''
}

function noteToMarkdown(note: string, indent: string): string {
  const quote = note.split(/\r?\n/).map((line) => `> ${line}`).join(`\n${indent}  `)
  return `${indent}  ${quote}`
}

/** 大纲树 → Markdown（无标题行；标题由调用方拼，避免重复） */
export function outlineToMarkdown(nodes: OutlineNode[]): string {
  const lines = flattenOutline(nodes)
  return lines
    .map((l) => {
      const indent = '  '.repeat(l.depth)
      const bullet = l.markdownText || l.note ? '- ' : ''
      const line = `${indent}${bullet}${taskPrefix(l.task)}${l.markdownText}`
      return l.note ? `${line}\n${noteToMarkdown(l.note, indent)}` : line
    })
    .join('\n')
}
