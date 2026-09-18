<script setup lang="ts">
import { ref, watch } from 'vue'
import { api, type ImportResult } from '../api'

const props = defineProps<{ modelValue: boolean; initialFiles: File[] }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean]; uploaded: [] }>()

const files = ref<File[]>([])
const category = ref('')
const uploading = ref(false)
const results = ref<ImportResult[]>([])
const dialogDragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      files.value = [...props.initialFiles]
      results.value = []
    }
  },
)

function addFiles(list: FileList | null) {
  const ok = Array.from(list ?? []).filter((f) => /\.(docx|pdf|txt|doc)$/i.test(f.name))
  files.value = [...files.value, ...ok]
}

function onDialogDrop(e: DragEvent) {
  dialogDragging.value = false
  addFiles(e.dataTransfer?.files ?? null)
}

function removeFile(i: number) {
  files.value = files.value.filter((_, idx) => idx !== i)
}

function close() {
  if (uploading.value) return
  emit('update:modelValue', false)
}

async function upload() {
  if (!files.value.length || uploading.value) return
  uploading.value = true
  try {
    const resp = await api.upload(files.value, category.value)
    results.value = resp.results
    emit('uploaded')
  } catch (e) {
    results.value = [
      {
        status: 'failed',
        title: '上传失败',
        document_id: 0,
        doc_type: '',
        article_count: 0,
        message: e instanceof Error ? e.message : String(e),
      },
    ]
  } finally {
    uploading.value = false
  }
}

const statusText: Record<string, string> = {
  imported: '已导入',
  duplicate: '重复，已跳过',
  failed: '失败',
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="mask" @click.self="close">
      <div class="dialog">
        <div class="dialog-head">
          <span>导入法律文档</span>
          <button class="close-btn" @click="close">✕</button>
        </div>

        <div class="dialog-body">
          <div
            class="drop-zone"
            :class="{ over: dialogDragging }"
            @dragover.prevent="dialogDragging = true"
            @dragleave="dialogDragging = false"
            @drop.prevent="onDialogDrop"
            @click="fileInput?.click()"
          >
            <p class="drop-main">点击选择文件，或拖拽到此处</p>
            <p class="drop-sub">支持 .docx / .pdf / .txt，可多选；.doc 老格式请先用转换脚本</p>
            <input
              ref="fileInput"
              type="file"
              multiple
              accept=".docx,.pdf,.txt,.doc"
              style="display: none"
              @change="addFiles(($event.target as HTMLInputElement).files)"
            />
          </div>

          <ul v-if="files.length" class="file-list">
            <li v-for="(f, i) in files" :key="i" class="file-row">
              <span class="file-name">{{ f.name }}</span>
              <span class="file-size">{{ (f.size / 1024).toFixed(0) }} KB</span>
              <button class="file-del" @click="removeFile(i)">✕</button>
            </li>
          </ul>

          <label class="category-line">
            分类（可选）：
            <input
              v-model="category"
              type="text"
              placeholder="如：民法典、公司法、劳动法"
            />
          </label>

          <div v-if="results.length" class="result-list">
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
          <button class="btn" @click="close">关闭</button>
          <button class="btn primary" :disabled="!files.length || uploading" @click="upload">
            {{ uploading ? '导入中…' : `导入 ${files.length || ''} 个文件` }}
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
  background: rgba(38, 35, 30, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.dialog {
  width: 520px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-radius: 12px;
  overflow: hidden;
}

.dialog-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  font-size: 15px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}

.close-btn {
  border: none;
  background: none;
  color: var(--muted);
  font-size: 14px;
}

.dialog-body {
  padding: 18px 20px;
  overflow-y: auto;
}

.drop-zone {
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius);
  padding: 26px 16px;
  text-align: center;
  cursor: pointer;
}

.drop-zone.over {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.drop-main {
  margin: 0 0 6px;
  font-size: 14px;
}

.drop-sub {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
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
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 6px;
  font-size: 13px;
}

.file-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-size {
  color: var(--muted);
  font-size: 12px;
}

.file-del {
  border: none;
  background: none;
  color: var(--muted);
}

.file-del:hover {
  color: var(--accent);
}

.category-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  font-size: 13px;
  color: var(--muted);
}

.category-line input {
  flex: 1;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
}

.category-line input:focus {
  border-color: var(--accent);
}

.result-list {
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
  background: var(--chip);
}

.result-row[data-status='failed'] {
  background: #fdecea;
}

.result-row[data-status='duplicate'] {
  background: #fdf3e3;
}

.result-status {
  flex-shrink: 0;
  font-weight: 600;
}

.result-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-detail {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 12px;
}

.result-msg {
  color: var(--muted);
  font-size: 12px;
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
}

.btn {
  height: 36px;
  padding: 0 20px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--panel);
  font-size: 13px;
}

.btn.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

.btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
