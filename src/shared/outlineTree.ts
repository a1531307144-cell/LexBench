// 大纲树纯函数层：查找 / 拍平 / 结构变动 / 拖拽块移动 / 拆分合并。
// 渲染层只负责 DOM 与焦点，所有树结构操作都在这里做（vitest 可直测）。
// 约定：所有函数直接修改传入的树（Vue 里就是 reactive 树），返回是否发生变动。

import { hasInlineFormatting } from './outlineRichText'
import type { OutlineNode } from './types'

export interface NodeLocation {
  node: OutlineNode
  parent: OutlineNode | null
  siblings: OutlineNode[]
  index: number
  depth: number
}

export interface FlatNode {
  node: OutlineNode
  depth: number
  parent: OutlineNode | null
  siblings: OutlineNode[]
  index: number
  hasChildren: boolean
  /** 折叠后被藏起来的后代数 */
  hidden: number
}

let idSeq = 0
/** 新节点 id（时间基 + 自增，避免同一毫秒内碰撞） */
export function newOutlineId(): string {
  idSeq += 1
  return `n${Date.now().toString(36)}${idSeq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

export function createOutlineNode(text = '', partial: Partial<OutlineNode> = {}): OutlineNode {
  const node: OutlineNode = {
    id: partial.id || newOutlineId(),
    text,
    children: partial.children ? partial.children : []
  }
  if (partial.fold) node.fold = true
  if (partial.ref) node.ref = { ...partial.ref }
  if (partial.image) node.image = partial.image
  if (partial.images?.length) node.images = [...partial.images]
  if (partial.html) node.html = partial.html
  if (partial.note) node.note = partial.note
  if (partial.heading) node.heading = partial.heading
  if (partial.task) node.task = partial.task
  return node
}

export function findNode(
  nodes: OutlineNode[],
  id: string,
  parent: OutlineNode | null = null,
  depth = 0
): NodeLocation | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (!node) continue
    if (node.id === id) return { node, parent, siblings: nodes, index: i, depth }
    const hit = findNode(node.children ?? [], id, node, depth + 1)
    if (hit) return hit
  }
  return null
}

export function countDescendants(node: OutlineNode): number {
  let n = 0
  for (const child of node.children ?? []) n += 1 + countDescendants(child)
  return n
}

/** 从根到目标节点的祖先链（含目标；找不到返回 null） */
export function nodePath(nodes: OutlineNode[], id: string): OutlineNode[] | null {
  const walk = (list: OutlineNode[], trail: OutlineNode[]): OutlineNode[] | null => {
    for (const node of list) {
      const next = [...trail, node]
      if (node.id === id) return next
      const hit = walk(node.children ?? [], next)
      if (hit) return hit
    }
    return null
  }
  return walk(nodes, [])
}

export function subtreeIds(node: OutlineNode): string[] {
  const out = [node.id]
  for (const child of node.children ?? []) out.push(...subtreeIds(child))
  return out
}

export function isDescendant(ancestor: OutlineNode, id: string): boolean {
  for (const child of ancestor.children ?? []) {
    if (child.id === id || isDescendant(child, id)) return true
  }
  return false
}

/** 拍平（渲染顺序）；skipCollapsed=true 时折叠子树不展开（导图/列表共用） */
export function flattenOutline(
  nodes: OutlineNode[],
  depth = 0,
  skipCollapsed = true,
  parent: OutlineNode | null = null,
  out: FlatNode[] = []
): FlatNode[] {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (!node) continue
    const hasChildren = (node.children ?? []).length > 0
    const hidden = hasChildren && node.fold ? countDescendants(node) : 0
    out.push({ node, depth, parent, siblings: nodes, index: i, hasChildren, hidden })
    if (hasChildren && !(skipCollapsed && node.fold)) {
      flattenOutline(node.children, depth + 1, skipCollapsed, node, out)
    }
  }
  return out
}

/** 可见行 id 顺序（范围多选用） */
export function visibleNodeIds(nodes: OutlineNode[]): string[] {
  return flattenOutline(nodes).map((r) => r.node.id)
}

/** 从可视顺序里取闭区间 id（顺序无关，自动纠正） */
export function rangeNodeIds(nodes: OutlineNode[], a: string, b: string): string[] {
  const ids = visibleNodeIds(nodes)
  const ia = ids.indexOf(a)
  const ib = ids.indexOf(b)
  if (ia < 0 || ib < 0) return []
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia]
  return ids.slice(lo, hi + 1)
}

/** 深拷贝子树；genId 用于复制/粘贴时重建 id */
export function cloneSubtree(node: OutlineNode, genId: (() => string) | null = null): OutlineNode {
  const copy: OutlineNode = {
    id: genId ? genId() : node.id,
    text: node.text,
    children: (node.children ?? []).map((c) => cloneSubtree(c, genId))
  }
  if (node.fold) copy.fold = true
  if (node.ref) copy.ref = { ...node.ref }
  if (node.image) copy.image = node.image
  if (node.images?.length) copy.images = [...node.images]
  if (node.html) copy.html = node.html
  if (node.note) copy.note = node.note
  if (node.heading) copy.heading = node.heading
  if (node.task) copy.task = node.task
  return copy
}

/** 在指定兄弟数组里插入节点（index 越界自动钳制） */
export function insertNodeAt(siblings: OutlineNode[], node: OutlineNode, index: number): void {
  const at = Math.max(0, Math.min(index, siblings.length))
  siblings.splice(at, 0, node)
}

/** 移除节点（返回被移除的节点；不存在返回 null） */
export function removeNode(nodes: OutlineNode[], id: string): OutlineNode | null {
  const hit = findNode(nodes, id)
  if (!hit) return null
  return hit.siblings.splice(hit.index, 1)[0] ?? null
}

/** 在目标之后插入同级节点 */
export function insertAfter(nodes: OutlineNode[], targetId: string, node: OutlineNode): boolean {
  const hit = findNode(nodes, targetId)
  if (!hit) return false
  hit.siblings.splice(hit.index + 1, 0, node)
  return true
}

/** 在目标之前插入同级节点 */
export function insertBefore(nodes: OutlineNode[], targetId: string, node: OutlineNode): boolean {
  const hit = findNode(nodes, targetId)
  if (!hit) return false
  hit.siblings.splice(hit.index, 0, node)
  return true
}

/** 追加为子节点（默认末尾；父级自动展开，避免新节点藏在折叠里） */
export function insertChild(
  nodes: OutlineNode[],
  parentId: string,
  node: OutlineNode,
  index?: number
): boolean {
  const hit = findNode(nodes, parentId)
  if (!hit) return false
  hit.node.fold = false
  insertNodeAt(hit.node.children, node, index ?? hit.node.children.length)
  return true
}

/** 降一级：成为上一同级节点的最后一个子节点（子树跟随） */
export function indentNode(nodes: OutlineNode[], id: string): boolean {
  const hit = findNode(nodes, id)
  if (!hit || hit.index === 0) return false
  const prev = hit.siblings[hit.index - 1]
  if (!prev) return false
  hit.siblings.splice(hit.index, 1)
  prev.fold = false
  prev.children.push(hit.node)
  return true
}

/** 升一级：插到父节点之后，成为父节点的同级（子树跟随） */
export function outdentNode(nodes: OutlineNode[], id: string): boolean {
  const hit = findNode(nodes, id)
  if (!hit || !hit.parent) return false
  const parentHit = findNode(nodes, hit.parent.id)
  if (!parentHit) return false
  hit.siblings.splice(hit.index, 1)
  parentHit.siblings.splice(parentHit.index + 1, 0, hit.node)
  return true
}

/** 上移一位（与前一兄弟交换）；返回是否移动 */
export function moveNodeUp(nodes: OutlineNode[], id: string): boolean {
  const hit = findNode(nodes, id)
  if (!hit || hit.index === 0) return false
  const prev = hit.siblings[hit.index - 1]
  if (!prev) return false
  hit.siblings[hit.index - 1] = hit.node
  hit.siblings[hit.index] = prev
  return true
}

/** 下移一位（与后一兄弟交换） */
export function moveNodeDown(nodes: OutlineNode[], id: string): boolean {
  const hit = findNode(nodes, id)
  if (!hit || hit.index >= hit.siblings.length - 1) return false
  const next = hit.siblings[hit.index + 1]
  if (!next) return false
  hit.siblings[hit.index + 1] = hit.node
  hit.siblings[hit.index] = next
  return true
}

function blockRoots(nodes: OutlineNode[], ids: string[]): OutlineNode[] {
  const wanted = new Set(ids)
  const all = flattenOutline(nodes, 0, false)
  const picked = all.filter((r) => wanted.has(r.node.id)).map((r) => r.node)
  // 只搬块根：祖先也在这批里时，后代随祖先走，不重复搬
  return picked.filter((node) => !picked.some((other) => other !== node && isDescendant(other, node.id)))
}

/** 把一批节点整体移动到某父级的指定下标（parentId=null 表示根列表） */
export function moveNodesTo(
  nodes: OutlineNode[],
  ids: string[],
  parentId: string | null,
  index: number
): boolean {
  if (!ids.length) return false
  const moving = blockRoots(nodes, ids)
  if (!moving.length) return false
  // 禁止把父节点拖进自己的子树
  if (parentId && moving.some((m) => m.id === parentId || isDescendant(m, parentId))) return false
  const movingIds = new Set(moving.map((m) => m.id))
  // 计算移除后目标父级的最终下标
  let parent: OutlineNode | null = null
  if (parentId) {
    const hit = findNode(nodes, parentId)
    if (!hit) return false
    parent = hit.node
    parent.fold = false
  }
  const siblings = parent ? parent.children : nodes
  let before = 0
  for (let i = 0; i < Math.min(index, siblings.length); i++) {
    const s = siblings[i]
    if (s && !movingIds.has(s.id)) before += 1
  }
  for (const node of moving) removeNode(nodes, node.id)
  const target = parent ? parent.children : nodes
  target.splice(before, 0, ...moving)
  return true
}

/** 拖拽落点：把一批节点放到目标子级 / 前 / 后 */
export function moveNodesRelative(
  nodes: OutlineNode[],
  ids: string[],
  targetId: string,
  mode: 'child' | 'before' | 'after'
): boolean {
  const target = findNode(nodes, targetId)
  if (!target) return false
  if (ids.includes(targetId)) return false
  for (const id of ids) {
    const loc = findNode(nodes, id)
    if (!loc) return false
    if (loc.node.id === targetId || isDescendant(loc.node, targetId)) return false
  }
  const moving = blockRoots(nodes, ids)
  if (!moving.length) return false
  // 目标在移动块里 → 拒绝（上面已兜底，这里再防一次）
  if (moving.some((m) => m.id === targetId || isDescendant(m, targetId))) return false

  let parentId: string | null
  let index: number
  if (mode === 'child') {
    parentId = target.node.id
    index = target.node.children.length
    target.node.fold = false
  } else {
    parentId = target.parent ? target.parent.id : null
    index = target.index + (mode === 'after' ? 1 : 0)
  }
  return moveNodesTo(nodes, ids, parentId, index)
}

/** 把节点拆成两行（Enter）：前半留在原节点，后半成为下一同级节点 */
export function splitOutlineNode(
  nodes: OutlineNode[],
  id: string,
  parts: { beforeText: string; afterText: string; beforeHtml?: string; afterHtml?: string },
  genId: () => string = newOutlineId
): OutlineNode | null {
  const hit = findNode(nodes, id)
  if (!hit) return null
  hit.node.text = parts.beforeText
  if (parts.beforeHtml && hasInlineFormatting(parts.beforeHtml, parts.beforeText)) {
    hit.node.html = parts.beforeHtml
  } else {
    delete hit.node.html
  }
  const created: OutlineNode = {
    id: genId(),
    text: parts.afterText,
    children: []
  }
  if (parts.afterHtml && hasInlineFormatting(parts.afterHtml, parts.afterText)) {
    created.html = parts.afterHtml
  }
  if (hit.node.heading) created.heading = hit.node.heading
  if (hit.node.task) created.task = hit.node.task
  hit.siblings.splice(hit.index + 1, 0, created)
  return created
}

/** 上一个可视行（展开态下前一个兄弟的最深可见后代，否则父级） */
export function previousVisibleRow(nodes: OutlineNode[], id: string): OutlineNode | null {
  const flat = flattenOutline(nodes)
  const i = flat.findIndex((r) => r.node.id === id)
  return i > 0 ? flat[i - 1]?.node ?? null : null
}

export interface MergeResult {
  node: OutlineNode
  /** 合并后光标应落在的纯文本偏移 */
  offset: number
}

/**
 * 行首 Backspace：并入上一个可视行（文本并尾、子树挂到上一行末尾）。
 * 顶级首行无可并返回 null。空行的合并在编辑器层先做反缩进。
 */
export function mergeOutlineNode(nodes: OutlineNode[], id: string): MergeResult | null {
  const hit = findNode(nodes, id)
  if (!hit) return null
  const prev = previousVisibleRow(nodes, id)
  if (!prev) return null
  const offset = prev.text.length
  prev.text += hit.node.text
  if (prev.html || hit.node.html) {
    // 两端都是富文本时做朴素拼接；一端为空时保留另一端
    if (prev.html && hit.node.html) prev.html = prev.html + hit.node.html
    else if (hit.node.html) prev.html = hit.node.html
  }
  prev.children.push(...(hit.node.children ?? []))
  if ((hit.node.task ?? 0) > 0 && !prev.task) prev.task = hit.node.task
  hit.siblings.splice(hit.index, 1)
  return { node: prev, offset }
}

/** 按层级折叠：level=1 只留顶层，level=2 留两层…… */
export function collapseByLevel(nodes: OutlineNode[], level: number): void {
  const walk = (list: OutlineNode[], depth: number): void => {
    for (const node of list) {
      if ((node.children ?? []).length) node.fold = depth >= Math.max(0, level - 1)
      walk(node.children ?? [], depth + 1)
    }
  }
  walk(nodes, 0)
}

export function collapseAll(nodes: OutlineNode[]): void {
  const walk = (list: OutlineNode[]): void => {
    for (const node of list) {
      if ((node.children ?? []).length) node.fold = true
      walk(node.children ?? [])
    }
  }
  walk(nodes)
}

export function expandAll(nodes: OutlineNode[]): void {
  const walk = (list: OutlineNode[]): void => {
    for (const node of list) {
      if (node.fold) delete node.fold
      walk(node.children ?? [])
    }
  }
  walk(nodes)
}

/** 展开某节点的所有祖先（聚焦被折叠里的节点时用） */
export function expandAncestors(nodes: OutlineNode[], id: string): void {
  const path = nodePath(nodes, id)
  if (!path) return
  for (const node of path) if (node.fold) delete node.fold
}

/** 读入时的兜底归一化：补齐 id/text/children，修掉重复 id（返回新树，不原地改） */
export function normalizeOutlineTree(raw: unknown, genId: () => string = newOutlineId): OutlineNode[] {
  const seen = new Set<string>()
  const walk = (list: unknown): OutlineNode[] => {
    if (!Array.isArray(list)) return []
    const out: OutlineNode[] = []
    for (const value of list) {
      if (!value || typeof value !== 'object') continue
      const it = value as Record<string, unknown>
      let id = typeof it.id === 'string' ? it.id : ''
      if (!id || seen.has(id)) id = genId()
      seen.add(id)
      const node: OutlineNode = {
        id,
        text: typeof it.text === 'string' ? it.text : '',
        children: walk(it.children)
      }
      if (it.fold === true) node.fold = true
      if (it.ref && typeof it.ref === 'object') {
        const ref = it.ref as Record<string, unknown>
        if (Number.isFinite(Number(ref.docId)) && Number.isFinite(Number(ref.articleId))) {
          node.ref = { docId: Number(ref.docId), articleId: Number(ref.articleId) }
        }
      }
      if (typeof it.image === 'string' && it.image) node.image = it.image
      if (Array.isArray(it.images)) {
        const images = it.images.filter((x): x is string => typeof x === 'string' && !!x)
        if (images.length) node.images = images
      }
      if (node.images?.length && !node.image) node.image = node.images[0]
      if (node.image && !node.images?.length) node.images = [node.image]
      if (typeof it.html === 'string' && it.html && hasInlineFormatting(it.html, node.text)) {
        node.html = it.html
      }
      if (typeof it.note === 'string' && it.note) node.note = it.note
      if (it.heading === 1 || it.heading === 2 || it.heading === 3) node.heading = it.heading
      if (it.task === 1 || it.task === 2) node.task = it.task
      out.push(node)
    }
    return out
  }
  return walk(raw)
}

/** 树的节点图片列表（兼容旧 image 字段） */
export function nodeImages(node: OutlineNode): string[] {
  if (node.images?.length) return node.images
  return node.image ? [node.image] : []
}

/** 全部图片文件名（贴图 URL 预取/备份检查用） */
export function collectOutlineImages(nodes: OutlineNode[]): string[] {
  const out = new Set<string>()
  const walk = (list: OutlineNode[]): void => {
    for (const node of list) {
      for (const img of nodeImages(node)) out.add(img)
      walk(node.children ?? [])
    }
  }
  walk(nodes)
  return [...out]
}
