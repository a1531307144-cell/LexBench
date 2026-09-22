<script setup lang="ts">
import { computed } from 'vue'
import type { SearchHit, SearchOutcome } from '@shared/types'
import { shortLawName } from '@shared/lawName'
import { buildHighlightTerms, highlightText } from '@shared/highlight'
import { RESULT_HINTS, pickDistinct } from '@shared/searchHints'

/** 空态「试试」示例：每次挂载随机换一组，别常年只有民法典 1077 */
const resultHint = pickDistinct(RESULT_HINTS, 1)[0] ?? RESULT_HINTS[0]

const props = withDefaults(
  defineProps<{
    results: SearchHit[]
    mode: SearchOutcome['mode']
    searched: boolean
    searching: boolean
    query: string
    selectedId: number
    hasDocs: boolean
    /** 打开着专题时，法条类结果右侧给一个「＋」直接收进专题 */
    addable?: boolean
    /** 正在加入的那条命中 id（−1 = 空闲），用来禁用按钮防连点 */
    addingId?: number
    /** 定位先行为空，本结果来自全文兜底 */
    fallback?: boolean
    /** 非空法规名零匹配后按条号全库救援 */
    rescued?: boolean
    /** 零结果是因为查询切不出 token */
    emptyReason?: 'no_tokens'
  }>(),
  { addable: false, addingId: -1, fallback: false, rescued: false }
)

defineEmits<{ select: [hit: SearchHit]; add: [hit: SearchHit] }>()

/**
 * 法条定位（如「民法典 1077」）返回的是条文全文、没有高亮摘要字段，
 * 只渲染 snippet 的话候选行就只剩「法规名 + 条号」，看不到内容。
 * 这里给没有摘要的结果补一段正文预览。
 */
const PREVIEW_CLIP = 96
function previewOf(content: string): string {
  const t = content.replace(/\s+/g, ' ').trim()
  return t.length > PREVIEW_CLIP ? t.slice(0, PREVIEW_CLIP) + '…' : t
}

// 关键词整词高亮：标题/条标/预览三处也标（snippet 由主进程按同一词条规则生成）。
// highlightText 内部先转义，v-html 安全；词条含完整原查询与空白词段（「民法典」「1077」
// 各自整词着色），不会被丢单字的分词截短成「民法」。
const hlTerms = computed(() => buildHighlightTerms(props.query))
function titleHtml(r: SearchHit): string {
  return highlightText(shortLawName(r.title), hlTerms.value)
}
function labelHtml(r: SearchHit): string {
  return highlightText(r.label, hlTerms.value)
}
function previewHtml(r: SearchHit): string {
  return highlightText(r.content ? previewOf(r.content) : '', hlTerms.value)
}

const typeNames: Record<string, string> = {
  statute: '法规',
  case: '案例',
  book: '书籍',
  other: '资料'
}
</script>

<template>
  <div class="result-list">
    <div v-if="!searched" class="empty">
      <template v-if="hasDocs">
        <p class="empty-title">开始检索</p>
        <p class="empty-line">试试：<code>{{ resultHint.locate }}</code>（法条定位）或 <code>{{ resultHint.full }}</code>（全文搜索）</p>
      </template>
      <template v-else>
        <p class="empty-title">文档库还是空的</p>
        <p class="empty-line">点击右上角「导入文档」，或直接把 docx / pdf / txt 文件拖进窗口</p>
      </template>
    </div>

    <div v-else-if="searching" class="empty">检索中…</div>

    <div v-else-if="results.length === 0" class="empty">
      <!-- 0 结果也标出实际走了哪个模式（含降级），否则用户不知道发生了什么 -->
      <div class="mode-line">
        <span v-if="mode === 'locate'" class="mode-chip locate">法条定位</span>
        <span v-else-if="mode === 'fulltext'" class="mode-chip">全文搜索</span>
        <span class="mode-text">“{{ query }}”</span>
      </div>
      <p class="empty-title">{{ emptyReason === 'no_tokens' ? '没有可检索的关键词' : '没有找到相关内容' }}</p>
      <p class="empty-line">
        <template v-if="emptyReason === 'no_tokens'">试试中文词语或数字</template>
        <template v-else>换个说法试试：用更短的关键词，或检查法条序号是否写对</template>
      </p>
      <p v-if="fallback" class="empty-line">法条定位无结果，已自动改用全文搜索</p>
    </div>

    <template v-else>
      <div class="mode-line">
        <span v-if="mode === 'locate'" class="mode-chip locate">法条定位</span>
        <span v-else-if="mode === 'fulltext'" class="mode-chip">全文搜索</span>
        <span class="mode-text">“{{ query }}”</span>
        <span class="mode-count">共 {{ results.length }} 条</span>
      </div>
      <!-- 来源注记：全文兜底 / 全库按条号救援——让降级过程可见 -->
      <p v-if="fallback" class="mode-note">法条定位无结果，已自动改用全文搜索</p>
      <p v-if="rescued" class="mode-note">法规名未匹配到，已按条号在全库中查找</p>
      <div
        v-for="r in results"
        :key="r.kind + '-' + r.id"
        class="item"
        :class="{ selected: r.kind === 'article' && r.id === selectedId }"
        @click="$emit('select', r)"
      >
        <div class="item-head">
          <!-- 法规名用智能简称：小窗里全名（最长 40 字）只会被截成
               「最高人民法院关于适用《…」，同部法规的（一）（二）分不出来 -->
          <span class="item-title" :title="r.title" v-html="titleHtml(r)"></span>
          <span class="item-type" :data-type="r.doc_type">{{ typeNames[r.doc_type] || r.doc_type }}</span>
          <button
            v-if="addable && r.kind === 'article'"
            class="item-add"
            title="加入当前专题"
            :disabled="addingId === r.id"
            @click.stop="$emit('add', r)"
          >
            ＋
          </button>
        </div>
        <div class="item-label" v-html="labelHtml(r)"></div>
        <!-- snippet 由主进程按同一词条规则转义+高亮生成，em 为关键词高亮 -->
        <div v-if="r.snippet" class="item-snippet" v-html="r.snippet"></div>
        <!-- 定位结果没有 snippet，退回正文预览——同样在本地按查询整词高亮 -->
        <div v-else-if="r.content" class="item-snippet plain" v-html="previewHtml(r)"></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.result-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.empty {
  padding: 48px 20px;
  text-align: center;
  color: var(--lb-muted);
}

.empty-title {
  font-size: 15px;
  font-family: var(--lb-serif);
  margin: 0 0 8px;
  color: var(--lb-text);
}

.empty-line {
  font-size: 13px;
  margin: 0;
  line-height: 1.8;
}

.empty-line code {
  background: var(--lb-chip);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--lb-accent);
}

.mode-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 10px;
  color: var(--lb-muted);
  font-size: 12px;
}

.mode-chip {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--lb-chip);
  color: var(--lb-muted);
  flex-shrink: 0;
}

.mode-chip.locate {
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
}

.mode-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 空态里的模式行居中（.empty 整体是居中文本流） */
.empty .mode-line {
  justify-content: center;
  padding-bottom: 4px;
}

.mode-count {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--lb-muted);
}

.mode-note {
  margin: -4px 0 10px;
  padding: 0 4px;
  font-size: 12px;
  color: var(--lb-muted);
}

.item {
  padding: 12px 14px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  margin-bottom: 8px;
  cursor: pointer;
  background: var(--lb-panel);
}

/* 悬停上浮：轻微抬起 + 阴影，暗示可点击 */
@media (prefers-reduced-motion: no-preference) {
  .item {
    transition:
      border-color 0.12s ease,
      transform 0.12s ease,
      box-shadow 0.12s ease;
    animation: lb-item-in 0.18s ease both;
  }

  .item:hover {
    transform: translateY(-1px);
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.07);
  }

  /* 渐次进入：前 8 项依次浮现（间隔 40ms），之后不再延迟 */
  .item:nth-child(1) { animation-delay: 0ms; }
  .item:nth-child(2) { animation-delay: 40ms; }
  .item:nth-child(3) { animation-delay: 80ms; }
  .item:nth-child(4) { animation-delay: 120ms; }
  .item:nth-child(5) { animation-delay: 160ms; }
  .item:nth-child(6) { animation-delay: 200ms; }
  .item:nth-child(7) { animation-delay: 240ms; }
  .item:nth-child(8) { animation-delay: 280ms; }
}

@keyframes lb-item-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.item:hover {
  border-color: var(--lb-accent-2);
}

.item.selected {
  border-color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.item-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.item-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--lb-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-type {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--lb-chip);
  color: var(--lb-muted);
}

.item-type[data-type='statute'] {
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.item-label {
  margin-top: 4px;
  font-family: var(--lb-serif);
  font-size: 14px;
  color: var(--lb-text);
}

.item-add {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  margin-left: 2px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 6px;
  background: var(--lb-panel);
  color: var(--lb-accent);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.item-add:hover {
  border-color: var(--lb-accent);
}

.item-add:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 没有高亮摘要时的纯文本正文预览 */
.item-snippet.plain {
  color: var(--lb-muted);
  opacity: 0.85;
}

.item-snippet {
  margin-top: 6px;
  font-size: 13px;
  color: var(--lb-muted);
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 关键词高亮全搜索面统一：Apple 式柔和琥珀底（--lb-hit），不再用蓝色加粗文字 */
.item :deep(em) {
  font-style: normal;
  font-weight: 600;
  background: var(--lb-hit);
  color: var(--lb-text);
  border-radius: 3px;
  padding: 0 2px;
  margin: 0 -1px;
  box-shadow: none;
}
</style>
