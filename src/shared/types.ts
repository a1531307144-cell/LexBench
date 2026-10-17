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
  /** 分编（编与章之间一层，如「第一分编　通则」；无法典分编的法规为空串） */
  subbranch: string
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
  subbranch?: string
  chapter?: string
  section?: string
  order_index?: number
}

export type SearchMode = 'auto' | 'locate' | 'fulltext'

export interface SearchOutcome {
  mode: 'none' | 'locate' | 'fulltext'
  query: string
  results: SearchHit[]
  /** 定位先行且为空，本响应来自全文兜底 */
  fallback?: boolean
  /** auto 第三段：非空 hint 零命中后按条号全库救援成功 */
  rescued?: boolean
  /** 零结果是因为查询切不出任何 token（而非有 token 但无命中） */
  emptyReason?: 'no_tokens'
}

// ---------- 研究工作台（阶段2） ----------
// 专题板块已整链路退场（2026-10，数据随迁移 015 删除）；专题类型一并移除，
// 现存导出仅剩读书笔记（export:saveBookNotes）。

export type ExportFormat = 'md' | 'docx'

export interface ExportResult {
  canceled: boolean
  /** 保存成功后的完整路径（canceled 时省略） */
  path?: string
}

// ---------- 法条批注（阅读板块阶段1） ----------

/**
 * 法条批注：锚定到「法条内选区」的永久眉批。
 * 锚点 = article_id + content 内字符起止偏移 + 原文引用（quote 渲染时校验/兜底高亮）。
 */
export interface AnnotationRow {
  id: number
  article_id: number
  quote: string
  start_offset: number
  end_offset: number
  content_md: string
  created_at: string
  updated_at: string
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

/** 接口协议：OpenAI 兼容（/chat/completions）或 Anthropic 兼容（/v1/messages） */
export type AiProtocol = 'openai' | 'anthropic'

/** AI 模型档案（界面视图，密钥只回掩码） */
export interface AiProfileRow {
  id: number
  name: string
  base_url: string
  model: string
  protocol: AiProtocol
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

/** AI 问答归档（通用问答 article_id=NULL 归入全局时间线；带法条的问答按条归档） */
export interface AiMessageRow {
  id: number
  article_id: number | null
  action: AiTask
  question: string
  answer_md: string
  /** JSON 序列化的 AiCitation[] */
  citations: string
  created_at: string
}
