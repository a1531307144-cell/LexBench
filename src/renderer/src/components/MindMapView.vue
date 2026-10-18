<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import jsMind from 'jsmind'
import 'jsmind/style/jsmind.css'
import 'jsmind/draggable-node' // 副作用注册拖动插件（拖拽改挂载）
import type { OutlineNode, OutlineRef } from '@shared/types'

/**
 * 导图视图（阶段2.2）：同一棵树的可编辑思维导图（⇄ 与大纲互转）。
 * - 数据往返：OutlineNode[] ↔ jsMind node_tree（虚拟 root 包裹多根列表）；
 * - ref/image 元数据走 jsMind 节点 data 字段，丢时按旧树 id 回查兜底；
 * - 结构/文本变更（edit 类型）与折叠（show 类型 expand/collapse）→ 序列化回 emit change；
 *   自身触发的回流用 pendingSelf 吞掉，防回环重载；
 * - 键位业界通例：Enter 兄弟 / Tab 子节点（自绑，jsMind 默认 mapping 无 Tab）/ Delete 删 /
 *   F2 编辑 / 空格 折叠——前四个为 jsMind 默认快捷键，直接启用 editable 即有。
 */
const props = defineProps<{
  tree: OutlineNode[]
  /** 中心主题文案（用笔记标题；导图内改动 root 不回写标题） */
  title: string
}>()
const emit = defineEmits<{
  (e: 'change', tree: OutlineNode[]): void
  (e: 'error', err: unknown): void
}>()

const hostEl = ref<HTMLElement | null>(null)
let jm: jsMind | null = null
/** 自身 change 回流标记（吞掉一次 props 回写，防全量重载闪屏） */
let pendingSelf = false
/** 旧树 id → 节点（ref/image 元数据回查兜底） */
let metaById = new Map<string, OutlineNode>()
/** show 后的 resize 兜底定时器（挂载瞬间容器测量可能为 0——jsMind 布局常见坑） */
let resizeTimers: ReturnType<typeof setTimeout>[] = []

function scheduleResize(): void {
  for (const t of resizeTimers) clearTimeout(t)
  resizeTimers = []
  // 挂载/重载后容器尺寸可能尚未稳定：两拍兜底（下一帧 + 稳定期）
  resizeTimers.push(setTimeout(() => jm?.resize(), 0))
  resizeTimers.push(setTimeout(() => jm?.resize(), 300))
}

const VIRTUAL_ROOT_ID = '_lb_root_'

// ---------- 映射：OutlineNode[] ↔ jsMind node_tree ----------

function toJsMind(nodes: OutlineNode[]): Record<string, unknown> {
  const walk = (ns: OutlineNode[]): unknown[] =>
    ns.map((n) => {
      const data: Record<string, unknown> = {}
      if (n.ref) data['ref'] = n.ref
      if (n.image) data['image'] = n.image
      return {
        id: n.id,
        topic: n.text,
        ...(Object.keys(data).length ? { data } : {}),
        ...(n.fold ? { expanded: false } : {}),
        children: walk(n.children)
      }
    })
  // 多根列表 → 虚拟 root 包裹（jsMind 单 root 结构）
  return { id: VIRTUAL_ROOT_ID, topic: props.title || '笔记', children: walk(nodes) }
}

function fromJsMind(data: unknown): OutlineNode[] {
  const d = data as { children?: unknown[] } | null
  if (!d) return []
  const walk = (items: unknown[] | undefined): OutlineNode[] =>
    (items ?? []).map((raw) => {
      const it = raw as {
        id: string
        topic?: string
        data?: Record<string, unknown>
        expanded?: boolean
        children?: unknown[]
      }
      const fallback = metaById.get(it.id)
      const ref = (it.data?.['ref'] as OutlineRef | undefined) ?? fallback?.ref
      const image = (it.data?.['image'] as string | undefined) ?? fallback?.image
      const node: OutlineNode = {
        id: it.id,
        text: it.topic ?? '',
        children: walk(it.children)
      }
      if (it.expanded === false) node.fold = true
      if (ref) node.ref = ref
      if (image) node.image = image
      return node
    })
  // get_data 的 data 恒为单 root 结构（show 时我们用虚拟 root 包裹多根列表；
  // root 的 id 可能在往返中被 jsMind 重置——不赌 id，恒取其 children 作为真实列表）
  return walk(d.children)
}

function indexTree(nodes: OutlineNode[]): Map<string, OutlineNode> {
  const m = new Map<string, OutlineNode>()
  const walk = (ns: OutlineNode[]): void => {
    for (const n of ns) {
      m.set(n.id, n)
      walk(n.children)
    }
  }
  walk(nodes)
  return m
}

// ---------- 双向同步 ----------

function syncToParent(): void {
  if (!jm) return
  try {
    // get_data('node_tree') 返回 NodeTreeFormat：{ meta, format, data }——取 .data 才是节点树
    const fmt = jm.get_data('node_tree') as { data?: unknown }
    metaById = indexTree(props.tree) // 用回流前的树做元数据兜底
    const out = fromJsMind(fmt.data)
    pendingSelf = true
    emit('change', out)
  } catch (e) {
    emit('error', e)
  }
}

function loadTree(nodes: OutlineNode[]): void {
  if (!jm) return
  metaById = indexTree(nodes)
  // show 期望完整 NodeTreeFormat：meta 必填（get_mind 读 src.meta.name，缺了抛错）+ data 包裹
  jm.show({
    meta: { name: 'lexbench-note', author: 'lexbench', version: '1.0' },
    format: 'node_tree',
    data: toJsMind(nodes)
  } as never)
  // 默认选中中心主题：切进导图方向键立即可用（不选中时左右键无反应，像功能缺失）
  jm.select_node(jm.get_root())
  scheduleResize()
  void paintImages(nodes)
}

// ---------- 节点贴图 → jsMind 背景图 ----------

const imageUrls = new Map<string, string>()

async function ensureUrl(fileName: string): Promise<string | null> {
  const hit = imageUrls.get(fileName)
  if (hit) return hit
  try {
    const buf = await window.lexbench.attachments.read(fileName)
    const url = URL.createObjectURL(new Blob([buf]))
    imageUrls.set(fileName, url)
    return url
  } catch {
    return null
  }
}

async function paintImages(nodes: OutlineNode[]): Promise<void> {
  if (!jm) return
  const targets: { id: string; image: string }[] = []
  const walk = (ns: OutlineNode[]): void => {
    for (const n of ns) {
      if (n.image) targets.push({ id: n.id, image: n.image })
      walk(n.children)
    }
  }
  walk(nodes)
  for (const t of targets) {
    const url = await ensureUrl(t.image)
    if (!url || !jm) return
    await new Promise<void>((resolve) => {
      const img = new Image()
      img.onload = () => {
        if (!jm) return resolve()
        const maxH = 120
        const scale = img.height > maxH ? maxH / img.height : 1
        try {
          jm.set_node_background_image(t.id, url, Math.round(img.width * scale), Math.round(img.height * scale))
        } catch {
          /* 节点已被删等边缘态忽略 */
        }
        resolve()
      }
      img.onerror = () => resolve()
      img.src = url
    })
  }
}

// ---------- 键盘：方向键（移动选中指针）+ Tab 加子 ----------
// 方向键由本组件接管（mapping 里已置空让 jsMind 不处理）。导航目标解析按业界导图通行的
// 两级降级策略：①结构规则（右向布局：→进子、←回父、↑↓换兄弟，多子时取纵向中心最近的子）
// → ②几何兜底（结构无解时全图可见节点找最近邻：垂直投影重叠过滤 + 方向边缘间距最小，
// 不斜跳）；每次选中后视口平移聚焦到可见位置。编辑态放行给输入框（原生光标移动）。

type MNode = NonNullable<ReturnType<jsMind['get_node']>>

function nodeFrame(n: MNode): { x: number; y: number; w: number; h: number } {
  const loc = n.get_location()
  const size = n.get_size()
  return { x: loc.x, y: loc.y, w: size.w, h: size.h }
}

/** 结构层-进子：多个子级取「垂直于生长轴方向中心最近」的（右向布局即 y 中心最近） */
function nearestChild(node: MNode, key: string): MNode | null {
  const kids = (node.children ?? []).filter((c) => jm!.layout.is_visible(c))
  if (!kids.length) return null
  if (kids.length === 1) return kids[0] ?? null
  const cur = nodeFrame(node)
  const vertical = key === 'ArrowUp' || key === 'ArrowDown'
  let best: MNode | null = null
  let bestDist = Infinity
  for (const c of kids) {
    const f = nodeFrame(c)
    // 按键沿兄弟排列方向（↑↓）时按 x 中心贴近；进子方向（→）按 y 中心贴近
    const d = vertical ? Math.abs(f.x + f.w / 2 - (cur.x + cur.w / 2)) : Math.abs(f.y + f.h / 2 - (cur.y + cur.h / 2))
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

/** 几何兜底：结构无解时全图可见节点最近邻（垂直投影重叠 + 方向边缘间距最小，不斜跳） */
function geometricFallback(node: MNode, key: string): MNode | null {
  if (!jm) return null
  const cur = nodeFrame(node)
  const vertical = key === 'ArrowUp' || key === 'ArrowDown'
  let best: MNode | null = null
  let bestGap = Infinity
  for (const n of Object.values(jm.mind.nodes)) {
    if (n.id === node.id || n.isroot) continue
    if (!jm.layout.is_visible(n)) continue
    const f = nodeFrame(n)
    // 垂直投影重叠过滤：↑↓ 只考虑 x 区间重叠的（正上/正下），←→ 只考虑 y 区间重叠的
    const xOverlap = f.x < cur.x + cur.w && cur.x < f.x + f.w
    const yOverlap = f.y < cur.y + cur.h && cur.y < f.y + f.h
    if (vertical ? !xOverlap : !yOverlap) continue
    const gap =
      key === 'ArrowUp'
        ? cur.y - (f.y + f.h)
        : key === 'ArrowDown'
          ? f.y - (cur.y + cur.h)
          : key === 'ArrowLeft'
            ? cur.x - (f.x + f.w)
            : f.x - (cur.x + cur.w)
    if (gap > 0 && gap < bestGap) {
      bestGap = gap
      best = n
    }
  }
  return best
}

function moveSelection(key: string): void {
  if (!jm) return
  const sel = jm.get_selected_node()
  if (!sel) {
    // 无选中（刚进导图/点过空白）：先选中中心主题，让键盘导航立即可用
    jm.select_node(jm.get_root())
    return
  }
  // ① 结构层：右向布局（→ 进子 / ← 回父 / ↑↓ 换兄弟，兄弟按视觉序）
  let target: MNode | null = null
  const kids = (sel.children ?? []).filter((c) => jm.layout.is_visible(c))
  if (key === 'ArrowRight') {
    target = kids.length ? nearestChild(sel, key) : null
  } else if (key === 'ArrowLeft') {
    target = sel.isroot ? null : sel.parent
  } else {
    const sibs = sel.parent ? sel.parent.children : []
    const i = sibs.findIndex((n) => n.id === sel.id)
    target = i >= 0 ? (sibs[i + (key === 'ArrowUp' ? -1 : 1)] ?? null) : null
    // 边界（第一个/最后一个兄弟）→ 落入几何兜底
    if (target && !jm.layout.is_visible(target)) target = null
  }
  // ② 几何兜底：结构无解（根按←、叶子按→、首尾兄弟、单节点）→ 屏幕最近邻
  if (!target) target = geometricFallback(sel, key)
  if (!target) return
  jm.select_node(target.id)
  // ③ 视口聚焦：新指针位置平移到可见（大图导航不丢目标）
  jm.scroll_node_to_center(target.id)
}

function onHostKeydown(e: KeyboardEvent): void {
  if (!jm || e.isComposing) return
  // 编辑态（正在改节点文字）：方向键=输入框光标移动，一个键都不拦
  if (jm.view.is_editing()) return
  if (
    e.key === 'ArrowLeft' ||
    e.key === 'ArrowRight' ||
    e.key === 'ArrowUp' ||
    e.key === 'ArrowDown'
  ) {
    e.preventDefault()
    moveSelection(e.key)
    return
  }
  if (e.key !== 'Tab') return // 其余键位（Enter/Delete/F2/Space）走 jsMind 默认
  const selected = jm.get_selected_node()
  if (!selected) return
  e.preventDefault()
  const id = `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  jm.add_node(selected.id, id, '新节点', undefined, selected.direction)
  jm.select_node(id)
  jm.begin_edit(id)
}

// ---------- 生命周期 ----------

onMounted(() => {
  if (!hostEl.value) return
  try {
    jm = new jsMind({
      container: hostEl.value,
      editable: true,
      theme: 'primary',
      // 方向键让位给本组件的 moveSelection（jsMind 原生 root 方向逻辑对单侧布局会空转）
      shortcut: { mapping: { left: [], up: [], right: [], down: [] } }
    })
    loadTree(props.tree)
    jm.add_event_listener((type, data) => {
      if (!jm) return
      // 结构/文本变更（edit）与折叠（show 下的 expand/collapse）都回写；初始 show 无 evt 不回写
      if (type === jsMind.event_type.edit) {
        syncToParent()
      } else if (type === jsMind.event_type.show && (data.evt === 'expand_node' || data.evt === 'collapse_node')) {
        syncToParent()
      }
    })
    hostEl.value.addEventListener('keydown', onHostKeydown)
  } catch (e) {
    emit('error', e)
  }
})

// 外部树变化（大纲侧改动/切笔记重挂）→ 重载；自身回流吞掉
watch(
  () => props.tree,
  (t) => {
    if (pendingSelf) {
      pendingSelf = false
      return
    }
    loadTree(t)
  }
)

// 笔记标题变化 → 中心主题跟随（视觉；导图内改 root 不回写）
watch(
  () => props.title,
  () => {
    if (jm && props.tree) loadTree(props.tree)
  }
)

onBeforeUnmount(() => {
  hostEl.value?.removeEventListener('keydown', onHostKeydown)
  for (const t of resizeTimers) clearTimeout(t)
  resizeTimers = []
  if (jm) {
    jm.clear_event_listener()
    jm = null
  }
  for (const url of imageUrls.values()) URL.revokeObjectURL(url)
  imageUrls.clear()
  if (hostEl.value) hostEl.value.innerHTML = ''
})

// 供模板无逻辑引用（避免 unused import 告警面）
void jsMind
</script>

<template>
  <div ref="hostEl" class="ol-mind" tabindex="0"></div>
</template>

<!-- jsMind 内部 DOM 不受 scoped 约束：加前缀 .ol-mind 限定作用域 -->
<style>
.ol-mind {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--lb-bg);
  outline: none;
}

/* 节点皮肤贴合全局 Apple 风（白底/细边/圆角/accent 选中） */
.ol-mind jmnode {
  background: #fff;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  box-shadow: var(--lb-shadow-1);
  font-size: 14px;
  color: var(--lb-text);
  font-family: inherit;
}

.ol-mind jmnode:hover {
  border-color: var(--lb-accent-2);
}

.ol-mind jmnode.selected {
  border-color: var(--lb-accent);
  box-shadow: 0 0 0 3px var(--lb-accent-soft);
}

.ol-mind jmnode .content {
  font-family: inherit;
}

.ol-mind jmnode.root {
  background: var(--lb-accent);
  border-color: var(--lb-accent);
}

.ol-mind jmnode.root .content {
  color: #fff;
  font-weight: 600;
}

.ol-mind jmnode .image-container img {
  border-radius: var(--lb-radius-xs);
}

/* 连接线用 accent 家族浅色 */
.ol-mind .lines path {
  stroke: rgba(0, 113, 227, 0.35);
}

/* 编辑态输入框贴全局输入风格 */
.ol-mind .jsmind-editor {
  border: 1px solid rgba(0, 113, 227, 0.55);
  border-radius: var(--lb-radius-xs);
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.12);
  font-size: 14px;
  font-family: inherit;
}
</style>
