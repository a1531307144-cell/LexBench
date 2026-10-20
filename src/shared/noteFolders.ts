/**
 * 笔记/文档文件夹的纯逻辑工具：内联新建取名与层级扁平化。
 * 放在 shared 里是为了让 App 与两个面板共用同一套规则，也便于单测覆盖。
 */

/** 文件夹的最小形状（note_groups / groups 行都满足） */
export interface FlatFolderLike {
  id: number
  name: string
  parent_id: number | null
}

/**
 * 生成不与同级重名的「未命名文件夹 / 未命名文件夹 2 / 未命名文件夹 3 ...」。
 * 只和同级名字比（不同父夹下的同名互不影响）。
 */
export function nextUntitledName(existing: string[], base = '未命名文件夹'): string {
  const taken = new Set(existing)
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base} ${i}`)) i += 1
  return `${base} ${i}`
}

/** 扁平化结果：depth 从 1 起（根层文件夹是 1，直接子夹是 2） */
export interface FlatFolderRow {
  id: number
  name: string
  depth: number
}

/**
 * 把文件夹树按「父在前、子紧随」的顺序压平，供「移动到…」这类缩进菜单渲染。
 * - 孤儿（parent_id 指向不存在的行）按根层处理，避免整支消失；
 * - 成环时截断循环路径（用 seen 兜底），保证一定终止；
 * - depth 超过 maxDepth 的整支不上屏（也不往下走），与旧菜单的缩进上限一致；
 */
export function flattenFolders<T extends FlatFolderLike>(folders: T[], maxDepth = 5): FlatFolderRow[] {
  const childrenOf = new Map<number | null, T[]>()
  const ids = new Set(folders.map((f) => f.id))
  for (const f of folders) {
    const parent = f.parent_id !== null && ids.has(f.parent_id) ? f.parent_id : null
    const list = childrenOf.get(parent)
    if (list) list.push(f)
    else childrenOf.set(parent, [f])
  }

  const out: FlatFolderRow[] = []
  const seen = new Set<number>()

  /** 被 maxDepth 跳过的一整支也要标 seen，否则会被当成「没接上根」又补回来 */
  const markSubtree = (parent: number | null): void => {
    for (const f of childrenOf.get(parent) ?? []) {
      if (seen.has(f.id)) continue
      seen.add(f.id)
      markSubtree(f.id)
    }
  }

  const walk = (parent: number | null, depth: number): void => {
    for (const f of childrenOf.get(parent) ?? []) {
      if (seen.has(f.id)) continue
      seen.add(f.id)
      if (depth > maxDepth) {
        markSubtree(f.id)
        continue
      }
      out.push({ id: f.id, name: f.name, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 1)
  // 成环的孤立支（整支都没接到根上）按根层补进来，不能在菜单里凭空消失
  for (const f of folders) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    out.push({ id: f.id, name: f.name, depth: 1 })
    walk(f.id, 2)
  }
  return out
}

/**
 * 从 id 沿 parent 链往上找，判断 candidate 是否在 ancestor 的子树里（含自身）。
 * 文件夹拖拽改归属时用它挡住「拖进自己/自己的后代」。
 */
export function isSelfOrDescendant(
  candidate: number,
  ancestor: number,
  parentOf: (id: number) => number | null
): boolean {
  let cur: number | null = candidate
  const seen = new Set<number>()
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestor) return true
    seen.add(cur)
    cur = parentOf(cur)
  }
  return false
}
