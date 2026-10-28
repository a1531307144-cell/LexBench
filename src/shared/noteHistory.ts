// 笔记撤销/重做历史（纯函数层，vitest 直测）。
// 每条 = 整树稳定序列化 + 标题；undo/redo 前先提交当前差异，
// 避免 700ms 汇总窗口内的输入被跳过或 redo 覆盖新输入。

export interface HistoryEntry {
  /** stableStringify 后的整树 JSON */
  tree: string
  title: string
}

export interface HistoryState {
  entries: HistoryEntry[]
  /** 指向 entries 中「当前已应用」的一条 */
  index: number
}

export const HISTORY_LIMIT = 100
/** 每篇笔记的字符预算（全树 JSON 合计），超出时从头部裁旧条目 */
export const HISTORY_CHAR_BUDGET = 2_000_000

export function sameEntry(a: HistoryEntry | undefined, b: HistoryEntry | undefined): boolean {
  return !!a && !!b && a.tree === b.tree && a.title === b.title
}

export function initHistory(entry: HistoryEntry): HistoryState {
  return { entries: [entry], index: 0 }
}

export function anchorOf(state: HistoryState): HistoryEntry | null {
  return state.entries[state.index] ?? null
}

/** 追加一条；与当前指针相同则不动；有 redo 分支则截断 */
export function pushHistory(
  state: HistoryState,
  entry: HistoryEntry,
  limit = HISTORY_LIMIT
): HistoryState {
  if (sameEntry(state.entries[state.index], entry)) return state
  let entries = [...state.entries.slice(0, state.index + 1), entry]
  if (entries.length > limit) entries = entries.slice(entries.length - limit)
  return { entries, index: entries.length - 1 }
}

/**
 * 撤销：先把当前未汇总的差异并入栈，再后退一步。
 * 这样 historyIndex=0 时的首步也能撤销，且当前输入可通过 redo 找回。
 */
export function undoHistory(
  state: HistoryState,
  current: HistoryEntry,
  limit = HISTORY_LIMIT
): { state: HistoryState; target: HistoryEntry } | null {
  const committed = pushHistory(state, current, limit)
  if (committed.index <= 0) return null
  const index = committed.index - 1
  const target = committed.entries[index]
  if (!target) return null
  return { state: { entries: committed.entries, index }, target }
}

/**
 * 重做：若当前有未汇总差异，先入栈（会截断 redo 分支），此时没有可重做的步骤。
 * 避免「撤销后又输入，再重做」把新输入覆盖掉。
 */
export function redoHistory(
  state: HistoryState,
  current: HistoryEntry,
  limit = HISTORY_LIMIT
): { state: HistoryState; target: HistoryEntry } | null {
  const committed = pushHistory(state, current, limit)
  if (committed.index >= committed.entries.length - 1) return null
  const index = committed.index + 1
  const target = committed.entries[index]
  if (!target) return null
  return { state: { entries: committed.entries, index }, target }
}

/** 外部改名：统一改写历史条目的标题，避免撤销把列表页刚改的名字倒回去 */
export function retitleHistory(entries: HistoryEntry[], title: string): HistoryEntry[] {
  let changed = false
  const out = entries.map((entry) => {
    if (entry.title === title) return entry
    changed = true
    return { ...entry, title }
  })
  return changed ? out : entries
}

export function retitleState(state: HistoryState, title: string): HistoryState {
  const entries = retitleHistory(state.entries, title)
  return entries === state.entries ? state : { entries, index: state.index }
}

/** 从头部裁掉超出字符预算的旧条目；绝不裁掉当前指针及其之前最后一条 */
export function trimHistory(state: HistoryState, maxChars = HISTORY_CHAR_BUDGET): HistoryState {
  let total = 0
  for (const entry of state.entries) total += entry.tree.length + entry.title.length
  if (total <= maxChars) return state
  let drop = 0
  while (drop < state.index && total > maxChars && state.entries.length - drop > 1) {
    const head = state.entries[drop]
    if (!head) break
    total -= head.tree.length + head.title.length
    drop += 1
  }
  if (drop === 0) return state
  return {
    entries: state.entries.slice(drop),
    index: Math.max(0, state.index - drop)
  }
}
