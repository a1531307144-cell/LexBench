// 领域类型：三进程共用（阶段1 v0.3.0 —— 导入/建库/检索/阅读器）
// 与 legacy/backend 的数据库 schema 一一对应，保证未来旧数据迁移无损

export type DocType = 'statute' | 'case' | 'other'
export type DocStatus = 'parsed' | 'needs_review'
export type ImportStatus = 'imported' | 'duplicate' | 'failed'

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
