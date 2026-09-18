<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { ImportResultItem } from '@shared/types'

/** 待导入文件（路径仅用于交回主进程读取；经原生对话框选择时拿不到大小，记 0） */
interface ImportFileEntry {
  path: string
  name: string
  size: number
}

const props = defineProps<{
  visible: boolean
  initialFiles: ImportFileEntry[]
}>()

const emit = defineEmits<{
  'update:visible': [v: boolean]
  /** 本轮导入请求完成（含部分失败），App 据此刷新文档库 */
  imported: []
  error: [message: string]
}>()

const files = ref<ImportFileEntry[]>([])
const category = ref('')
const importing = ref(false)
const results = ref<ImportResultItem[]>([])
const zoneOver = ref(false)
const note = ref('')

let noteTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.visible,
  (open) => {
    if (open) {
      files.value = props.initialFiles.filter((f) => f.path)
      results.value = []
      note.value = ''
      zoneOver.value = false
    }
  }
)

function setNote(msg: string): void {
  note.value = msg
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => {
    note.value = ''
  }, 4000)
}

/** 点击 drop-zone：走原生文件选择器 */
async function pickFiles(): Promise<void> {
  if (importing.value) return
  try {
    const r = await window.lexbench.dialog.pickImportFiles()
    if (!r.canceled) addPaths(r.paths)
  } catch (e) {
    emit('error', errText(e))
  }
}

function addPaths(paths: string[]): void {
  const known = new Set(files.value.map((f) => f.path))
  for (const p of paths) {
    if (!p || known.has(p)) continue
    known.add(p)
    files.value.push({ path: p, name: basename(p), size: 0 })
  }
}

/** 对话框内拖拽：File 经 webUtils 取本地路径 */
function onZoneDrop(e: DragEvent): void {
  zoneOver.value = false
  const list = Array.from(e.dataTransfer?.files ?? [])
  if (!list.length) return
  const known = new Set(files.value.map((f) => f.path))
  let rejected = 0
  for (const f of list) {
    if (!/\.(docx|pdf|txt|doc)$/i.test(f.name)) {
      rejected++
      continue
    }
    const path = window.lexbench.dialog.getPathForFile(f)
    if (!path) {
      rejected++
      continue
    }
    if (known.has(path)) continue
    known.add(path)
    files.value.push({ path, name: f.name, size: f.size })
  }
  if (rejected > 0) {
    setNote(`已忽略 ${rejected} 个无法导入的文件（仅支持 .docx / .pdf / .txt）`)
  }
}

function removeFile(i: number): void {
  if (importing.value) return
  files.value = files.value.filter((_, idx) => idx !== i)
}

function close(): void {
  if (importing.value) return // 导入中禁关闭
  emit('update:visible', false)
}

async function startImport(): Promise<void> {
  if (!files.value.length || importing.value) return
  importing.value = true
  results.value = []
  try {
    const res = await window.lexbench.library.importDocuments(
      files.value.map((f) => f.path),
      category.value.trim()
    )
    results.value = res
    emit('imported')
    // 已成功（含重复跳过）的文件自动移出待传列表，避免一键重传制造重复（修复旧版 #14）
    const failedIdx = new Set<number>()
    res.forEach((r, i) => {
      if (r.status === 'failed') failedIdx.add(i)
    })
    files.value = files.value.filter((_, i) => failedIdx.has(i))
  } catch (e) {
    // 整体请求失败：伪造一条 failed 结果展示，原文件保留可重试
    results.value = [
      {
        status: 'failed',
        title: '导入请求失败',
        document_id: 0,
        doc_type: 'other',
        article_count: 0,
        message: errText(e)
      }
    ]
  } finally {
    importing.value = false
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '')
}

const statusText: Record<ImportResultItem['status'], string> = {
  imported: '已导入',
  duplicate: '重复，已跳过',
  failed: '失败'
}

onBeforeUnmount(() => clearTimeout(noteTimer))
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="mask" @click.self="close">
      <div class="dialog">
        <div class="dialog-head">
          <span>导入法律文档</span>
          <button class="close-btn" :disabled="importing" @click="close">✕</button>
        </div>

        <div class="dialog-body">
          <div
            class="drop-zone"
            :class="{ over: zoneOver }"
            @dragover.prevent="zoneOver = true"
            @dragleave="zoneOver = false"
            @drop.prevent="onZoneDrop"
            @click="pickFiles"
          >
            <p class="drop-main">点击选择文件，或拖拽到此处</p>
            <p class="drop-sub">支持 .docx / .pdf / .txt，可多选；.doc 老格式请先转为 .docx</p>
          </div>

          <p v-if="note" class="note">{{ note }}</p>

          <ul v-if="files.length" class="file-list">
            <li v-for="(f, i) in files" :key="f.path" class="file-row">
              <span class="file-name">{{ f.name }}</span>
              <span class="file-size">{{ f.size > 0 ? `${(f.size / 1024).toFixed(0)} KB` : '' }}</span>
              <button class="file-del" title="移除" :disabled="importing" @click="removeFile(i)">✕</button>
            </li>
          </ul>

          <label class="category-line">
            分类（可选）：
            <input
              v-model="category"
              type="text"
              placeholder="如：民法典、公司法、劳动法"
              :disabled="importing"
            />
          </label>

          <div v-if="results.length" class="result-block">
            <div v-for="(r, i) in results" :key="i" class="result-row" :data-status="r.status">
              <span class="result-status">{{ statusText[r.status] || r.status }}</span>
              <span class="result-title">{{ r.title }}</span>
              <span v-if="r.status === 'imported'" class="result-detail">
                {{ r.doc_type === 'statute' ? `${r.article_count} 条` : '已分块索引' }}
              </span>
              <span v-if="r.message" class="result-msg">{{ r.message }}</span>
            </div>
          </div>
        </div>

        <div class="dialog-foot">
          <button class="dlg-btn" :disabled="importing" @click="close">关闭</button>
          <button
            class="dlg-btn primary"
            :disabled="!files.length || importing"
            @click="startImport"
          >
            {{ importing ? '导入中…' : `开始导入${files.length ? `（${files.length}）` : ''}` }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(30, 28, 40, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;
}

.dialog {
  width: 540px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  background: var(--lb-panel);
  border-radius: var(--lb-radius-l);
  overflow: hidden;
  box-shadow: 0 12px 36px rgba(24, 28, 55, 0.2);
}

.dialog-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  font-size: 15px;
  font-weight: 600;
  color: var(--lb-text);
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.close-btn {
  border: none;
  background: none;
  color: var(--lb-muted);
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 5px;
}

.close-btn:hover:not(:disabled) {
  background: var(--lb-chip);
  color: var(--lb-text);
}

.dialog-body {
  padding: 18px 20px;
  overflow-y: auto;
}

.drop-zone {
  border: 1.5px dashed var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  padding: 26px 16px;
  text-align: center;
  cursor: pointer;
}

.drop-zone:hover,
.drop-zone.over {
  border-color: var(--lb-accent-2);
  background: var(--lb-accent-soft);
}

.drop-main {
  margin: 0 0 6px;
  font-size: 14px;
  color: var(--lb-text);
}

.drop-sub {
  margin: 0;
  font-size: 12px;
  color: var(--lb-muted);
}

.note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--lb-warn-fg);
}

.file-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  max-height: 180px;
  overflow-y: auto;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid var(--lb-border);
  border-radius: 6px;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--lb-text);
}

.file-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-size {
  color: var(--lb-muted);
  font-size: 12px;
  flex-shrink: 0;
}

.file-del {
  border: none;
  background: none;
  color: var(--lb-muted);
  flex-shrink: 0;
}

.file-del:hover:not(:disabled) {
  color: var(--lb-accent);
}

.category-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  font-size: 13px;
  color: var(--lb-muted);
  flex-shrink: 0;
}

.category-line input {
  flex: 1;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 6px;
  font-size: 13px;
  color: var(--lb-text);
  outline: none;
}

.category-line input:focus {
  border-color: var(--lb-accent-2);
}

.result-block {
  margin-top: 14px;
}

.result-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 4px;
  background: var(--lb-chip);
  color: var(--lb-text);
}

.result-row[data-status='imported'] {
  background: var(--lb-ok-bg);
}

.result-row[data-status='duplicate'] {
  background: var(--lb-warn-bg);
}

.result-row[data-status='failed'] {
  background: var(--lb-err-bg);
}

.result-status {
  flex-shrink: 0;
  font-weight: 600;
}

.result-row[data-status='imported'] .result-status {
  color: var(--lb-ok-fg);
}

.result-row[data-status='duplicate'] .result-status {
  color: var(--lb-warn-fg);
}

.result-row[data-status='failed'] .result-status {
  color: var(--lb-err-fg);
}

.result-title {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.result-detail {
  flex-shrink: 0;
  color: var(--lb-muted);
  font-size: 12px;
}

.result-msg {
  flex-shrink: 0;
  color: var(--lb-muted);
  font-size: 12px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.dlg-btn {
  height: 36px;
  padding: 0 20px;
  border-radius: var(--lb-radius-s);
  border: 1px solid var(--lb-border-strong);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 13px;
}

.dlg-btn.primary {
  border-color: var(--lb-accent);
  background: var(--lb-grad);
  color: #fff;
}

.dlg-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
