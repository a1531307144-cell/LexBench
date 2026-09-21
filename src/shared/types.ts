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
  /** 原始扩展名（含点，如 '.pdf'）；决定阅读模式：pdf 书籍=页面模式，其余=文字模式 */
  file_ext: string
  /** 所属分类文件夹（未分类为 null） */
  group_id: number | null
}

/** 用户自建分类文件夹（每个文档类型下各自一套；名称可自定义） */
export interface DocGroupRow {
  id: number
  doc_type: DocType
  name: string
  created_at: string
  /** 该文件夹下文档数 */
  doc_count: number
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

/** 划选批注：起止锚点（起段 seq+偏移 / 止段 seq+偏移），支持跨段划选，渲染时恢复高亮 */
export interface BookNoteRow {
  id: number
  document_id: number
  content_md: string
  quote: string
  start_para: number
  start_offset: number
  end_para: number
  end_offset: number
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

// ---------- AI 研究助手（v0.7.0） ----------

/** AI 任务：解读本条 / 找案例 / 追问 */
export type AiTask = 'explain' | 'cases' | 'followup'

/** AI 模型档案（界面视图，密钥只回掩码） */
export interface AiProfileRow {
  id: number
  name: string
  base_url: string
  model: string
  /** 1=当前启用 */
  is_active: number
  created_at: string
  /** 掩码后的密钥（未配置为空串） */
  api_key_masked: string
  api_key_set: boolean
}

/** 回答中的引用：articleId 为空表示库内未收录该条文（不可点击） */
export interface AiCitation {
  articleId: number | null
  title: string
  label: string
  citeText: string
}

/** AI 问答归档（按条文/专题分组） */
export interface AiMessageRow {
  id: number
  article_id: number | null
  topic_id: number | null
  action: AiTask
  question: string
  answer_md: string
  /** JSON 序列化的 AiCitation[] */
  citations: string
  created_at: string
}
