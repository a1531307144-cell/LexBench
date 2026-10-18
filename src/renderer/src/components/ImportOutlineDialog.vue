<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ImportPreviewItem, ImportRunItem } from '@shared/types'

/**
 * 通用大纲笔记导入（阶段3）：选文件 → 预检（逐篇可剔除）→ 执行 → 结果。
 * 支持 OPML / HTML / Markdown 等业界通用格式；同源文件（内容摘要）重复可跳过或覆盖。
 * 交互配方对齐 ConfirmModal（Teleport + 遮罩 + 卡片）。
 */
const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'error', err: unknown): void
  /** 导入成功后通知父级刷新列表 */
  (e: 'imported'): void
}>()

type Stage = 'pick' | 'preview' | 'running' | 'done'
const stage = ref<Stage>('pick')
const items = ref<(ImportPreviewItem & { selected: boolean })[]>([])
/** 重复文件策略：skip=跳过 / append=仍然导入（标题加后缀） */
const dupPolicy = ref<'skip' | 'append'>('skip')
const runResults = ref<ImportRunItem[]>([])

const selectedPaths = computed(() => items.value.filter((i) => i.selected && !i.error).map((i) => i.path))
const dupCount = computed(() => items.value.filter((i) => i.duplicate && !i.error).length)
const errCount = computed(() => items.value.filter((i) => i.error).length)
const doneStats = computed(() => {
  const r = runResults.value
  return {
    imported: r.filter((x) => x.status === 'imported' || x.status === 'replaced').length,
    skipped: r.filter((x) => x.status === 'skipped').length,
    failed: r.filter((x) => x.status === 'failed').length,
    imagesFailed: r.reduce((s, x) => s + (x.imagesFailed ?? 0), 0)
  }
})

function close(): void {
  emit('update:visible', false)
}

function reset(): void {
  stage.value = 'pick'
  items.value = []
  runResults.value = []
  dupPolicy.value = 'skip'
}

async function pickFiles(): Promise<void> {
  try {
    const r = await window.lexbench.outlines.pickImportFiles()
    if (r.canceled || !r.paths.length) return
    const preview = await window.lexbench.outlines.previewImport(r.paths)
    items.value = preview.map((p) => ({ ...p, selected: !p.error }))
    stage.value = 'preview'
  } catch (e) {
    emit('error', e)
  }
}

function toggle(i: ImportPreviewItem): void {
  const hit = items.value.find((x) => x.path === i.path)
  if (hit && !hit.error) hit.selected = !hit.selected
}

async function startImport(): Promise<void> {
  if (!selectedPaths.value.length) return
  stage.value = 'running'
  try {
    // 重复文件按策略分流：append 时全部走 runImport（内部对重复做覆盖前缀处理）
    runResults.value = await window.lexbench.outlines.runImport(selectedPaths.value, dupPolicy.value)
    stage.value = 'done'
    if (doneStats.value.imported > 0) emit('imported')
  } catch (e) {
    stage.value = 'preview'
    emit('error', e)
  }
}

function finish(): void {
  close()
  setTimeout(reset, 300)
}

const formatNames: Record<string, string> = { opml: 'OPML', html: 'HTML', md: 'Markdown' }
</script>

<template>
  <Teleport to="body">
    <transition name="dlg-fade">
      <div v-if="visible" class="id-mask" @click.self="stage !== 'running' && close()">
        <div class="id-card">
          <div class="id-head">
            <span class="id-title">导入大纲笔记</span>
            <button
              v-if="stage !== 'running'"
              class="id-close"
              title="关闭"
              @click="stage === 'done' ? finish() : close()"
            >
              ✕
            </button>
          </div>

          <!-- 选文件 -->
          <template v-if="stage === 'pick'">
            <p class="id-desc">
              从导出文件导入大纲笔记，支持 OPML / HTML / Markdown 等业界通用格式。
              在源软件中逐篇导出后，把文件选进来即可（可多选）。
            </p>
            <div class="id-btns">
              <button class="id-btn primary" @click="pickFiles">选择文件…</button>
            </div>
          </template>

          <!-- 预检 -->
          <template v-else-if="stage === 'preview'">
            <div class="id-list">
              <div v-for="i in items" :key="i.path" class="id-item" @click="toggle(i)">
                <input
                  type="checkbox"
                  :checked="i.selected"
                  :disabled="!!i.error"
                  @click.stop="toggle(i)"
                />
                <div class="ipi-main">
                  <span class="ipi-title">{{ i.title || i.name }}</span>
                  <span class="ipi-meta">
                    {{ i.error ? i.error : `${formatNames[i.format] ?? i.format} · ${i.nodeCount} 个节点` }}
                    <template v-if="i.imageCount > 0"> · {{ i.imageCount }} 张图片</template>
                    <template v-if="i.duplicate && !i.error">
                      · <b class="ipi-dup">已导入过</b>
                    </template>
                  </span>
                </div>
              </div>
            </div>
            <p v-if="dupCount > 0" class="id-note">
              {{ dupCount }} 个文件与已有笔记同源：
              <label class="id-radio"><input v-model="dupPolicy" type="radio" value="skip" /> 跳过</label>
              <label class="id-radio"><input v-model="dupPolicy" type="radio" value="append" /> 仍然导入（标题加序号）</label>
            </p>
            <p v-if="errCount > 0" class="id-note warn">{{ errCount }} 个文件无法解析（已置灰，不参与导入）</p>
            <div class="id-btns">
              <button class="id-btn" @click="stage = 'pick'; items = []">重新选择</button>
              <button class="id-btn primary" :disabled="!selectedPaths.length" @click="startImport">
                开始导入（{{ selectedPaths.length }}）
              </button>
            </div>
          </template>

          <!-- 进行中 -->
          <template v-else-if="stage === 'running'">
            <div class="id-running">
              <span class="id-spinner" aria-hidden="true"></span>
              <p>正在导入…（解析与图片下载可能需要一点时间）</p>
            </div>
          </template>

          <!-- 结果 -->
          <template v-else>
            <div class="id-stats">
              <span>成功 {{ doneStats.imported }}</span>
              <span v-if="doneStats.skipped">跳过 {{ doneStats.skipped }}</span>
              <span v-if="doneStats.failed" class="bad">失败 {{ doneStats.failed }}</span>
              <span v-if="doneStats.imagesFailed" class="bad">{{ doneStats.imagesFailed }} 张图片未下载（已保留原链接）</span>
            </div>
            <div class="id-list">
              <div v-for="r in runResults" :key="r.path" class="id-item static">
                <span class="ipi-mark" :class="r.status">{{ r.status === 'failed' ? '✗' : r.status === 'skipped' ? '–' : '✓' }}</span>
                <div class="ipi-main">
                  <span class="ipi-title">{{ r.path.split(/[\\/]/).pop() }}</span>
                  <span class="ipi-meta" :class="{ bad: r.status === 'failed' }">
                    {{ r.message || ({ imported: '已导入', replaced: '已替换导入', skipped: '已跳过', failed: '失败' } as Record<string, string>)[r.status] }}
                  </span>
                </div>
              </div>
            </div>
            <div class="id-btns">
              <button class="id-btn primary" @click="finish">完成</button>
            </div>
          </template>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.id-mask {
  position: fixed;
  inset: 0;
  z-index: 700;
  background: rgba(30, 28, 40, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
}

.id-card {
  width: min(560px, calc(100vw - 48px));
  max-height: min(640px, calc(100vh - 80px));
  display: flex;
  flex-direction: column;
  background: var(--lb-panel);
  border-radius: var(--lb-radius-xl);
  corner-shape: var(--lb-corner-shape);
  box-shadow: var(--lb-shadow-3);
  padding: 18px 20px;
}

.id-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  flex-shrink: 0;
}

.id-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--lb-text);
}

.id-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: var(--lb-chip);
  color: var(--lb-muted);
  font-size: 13px;
}

.id-close:hover {
  color: var(--lb-text);
}

.id-desc {
  font-size: 13px;
  color: var(--lb-muted);
  line-height: 1.7;
  padding: 6px 2px 14px;
}

.id-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0;
}

.id-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--lb-radius-s);
  border: 1px solid transparent;
  cursor: pointer;
}

.id-item:hover {
  background: #f4f4f8;
}

.id-item.static {
  cursor: default;
}

.id-item input[type='checkbox'] {
  accent-color: var(--lb-accent);
  width: 15px;
  height: 15px;
}

.ipi-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ipi-title {
  font-size: 13px;
  color: var(--lb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ipi-meta {
  font-size: 11px;
  color: var(--lb-muted);
}

.ipi-meta.bad {
  color: var(--lb-err-fg);
}

.ipi-dup {
  color: var(--lb-warn-fg);
}

.ipi-mark {
  flex-shrink: 0;
  width: 18px;
  text-align: center;
  font-size: 12px;
}

.ipi-mark.imported,
.ipi-mark.replaced {
  color: var(--lb-ok-fg);
}

.ipi-mark.skipped {
  color: var(--lb-muted);
}

.ipi-mark.failed {
  color: var(--lb-err-fg);
}

.id-note {
  font-size: 12px;
  color: var(--lb-muted);
  padding: 8px 2px 0;
  flex-shrink: 0;
}

.id-note.warn {
  color: var(--lb-err-fg);
}

.id-radio {
  margin-left: 10px;
  cursor: pointer;
}

.id-btns {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 14px;
  flex-shrink: 0;
}

.id-btn {
  padding: 8px 18px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  font-size: 13px;
  color: var(--lb-text);
}

.id-btn:hover:not(:disabled) {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.id-btn.primary {
  background: var(--lb-accent);
  border-color: var(--lb-accent);
  color: #fff;
}

.id-btn.primary:hover:not(:disabled) {
  background: var(--lb-accent-2);
  border-color: var(--lb-accent-2);
  color: #fff;
}

.id-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.id-running {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 36px 0;
  color: var(--lb-muted);
  font-size: 13px;
}

.id-spinner {
  width: 26px;
  height: 26px;
  border: 3px solid var(--lb-chip);
  border-top-color: var(--lb-accent);
  border-radius: 50%;
  animation: id-spin 0.8s linear infinite;
}

@keyframes id-spin {
  to {
    transform: rotate(360deg);
  }
}

.id-stats {
  display: flex;
  gap: 14px;
  padding: 4px 2px 10px;
  font-size: 13px;
  color: var(--lb-text);
  flex-shrink: 0;
}

.id-stats .bad {
  color: var(--lb-err-fg);
}
</style>
