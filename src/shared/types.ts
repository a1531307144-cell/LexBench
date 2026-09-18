// 领域类型：三进程共用（阶段1 v0.3.0 —— 导入/建库/检索/阅读器）
// 与 legacy/backend 的数据库 schema 一一对应，保证未来旧数据迁移无损

export type DocType = 'statute' | 'case' | 'other' | 'book'
export type DocStatus = 'parsed' | 'needs_review'
export type ImportStatus = 'imported' | 'duplicate' | 'failed'

/** 导入时的类型选择：auto = 自动识别（现有启发式），其余为手动指定 */
export type ImportTypeChoice = 'auto' | DocType

export interface DocumentRow {
  id: number
  title: string
  doc_type: DocType
  category: string
  file_hash: string
  original_path: string
  status: DocStatus
  article_count: number
  imported_at: string
}

export interface ArticleRow {
  id: number
  document_id: number
  article_label: string
  article_no: number
  branch: string
  chapter: string
  section: string
  content: string
  order_index: number
  /** JOIN documents 带出的冗余展示字段 */
  title?: string
  category?: string
  doc_type?: DocType
}

export interface ChunkRow {
  id: number
  document_id: number
  seq: number
  content: string
}

export interface DocumentDetail extends DocumentRow {
  articles: ArticleRow[]
  chunks: ChunkRow[]
}

/** 文档导入：逐文件结果（与 legacy ImportResult 对应） */
export interface ImportResultItem {
  status: ImportStatus
  title: string
  document_id: number
  doc_type: DocType
  article_count: number
  message: string
}

export interface ArticleNeighbors {
  id: number
  label: string
}

export interface ArticleDetail {
  article: ArticleRow
  prev: ArticleNeighbors | null
  next: ArticleNeighbors | null
}

/** 检索结果条目：locate 返回法条全字段；fulltext 返回高亮摘要 */
export interface SearchHit {
  kind: 'article' | 'chunk'
  id: number
  document_id: number
  doc_type: DocType
  title: string
  category: string
  label: string
  snippet?: string
  content?: string
  branch?: string
  chapter?: string
  section?: string
  order_index?: number
}

export type SearchMode = 'auto' | 'locate' | 'fulltext'

export interface SearchOutcome {
  mode: 'none' | 'locate' | 'fulltext'
  query: string
  results: SearchHit[]
}

// ---------- 研究工作台（阶段2） ----------

export interface TopicRow {
  id: number
  name: string
  description: string
  created_at: string
  updated_at: string
  item_count: number
  note_count: number
}

/** 专题详情里的收藏条目：条目行 + JOIN 出的法条/文档展示字段 */
export interface TopicItemRow {
  id: number
  topic_id: number
  article_id: number
  order_index: number
  added_at: string
  article_label: string
  title: string
  category: string
  content: string
}

export interface NoteRow {
  id: number
  topic_id: number
  /** 可空：不关联具体法条 = 专题级笔记 */
  article_id: number | null
  content_md: string
  created_at: string
  updated_at: string
  /** LEFT JOIN 出的关联条文标签，供卡片展示（无关联时为 null） */
  article_label: string | null
}

export interface TopicDetail {
  id: number
  name: string
  description: string
  items: TopicItemRow[]
  notes: NoteRow[]
}

export type ExportFormat = 'md' | 'docx'

export interface ExportResult {
  canceled: boolean
  /** 保存成功后的完整路径（canceled 时省略） */
  path?: string
}

// ---------- 阅读模式（阶段2.5，并入 v0.4.0） ----------

/** 划选批注：锚定到段落序号（= chunks.seq）与段内字符区间，渲染时恢复高亮 */
export interface BookNoteRow {
  id: number
  document_id: number
  content_md: string
  quote: string
  para_index: number
  quote_start: number
  quote_end: number
  created_at: string
  updated_at: string
}

/** 新建批注的输入（quote/偏移由渲染层从选区计算） */
export interface BookNoteInput {
  contentMd: string
  quote: string
  paraIndex: number
  quoteStart: number
  quoteEnd: number
}

/** 阅读进度（settings 表 reading_progress:<docId> 的解析形态） */
export interface ReadingProgress {
  paraIndex: number
  updatedAt: string
}
