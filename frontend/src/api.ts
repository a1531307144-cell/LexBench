export interface ArticleBrief {
  id: number
  label: string
}

export interface ArticleDetail {
  id: number
  document_id: number
  title: string
  category: string
  label: string
  article_no: number
  branch: string
  chapter: string
  section: string
  content: string
  prev: ArticleBrief | null
  next: ArticleBrief | null
}

export interface ArticleRow {
  id: number
  article_label: string
  article_no: number
  branch: string
  chapter: string
  section: string
  content: string
  order_index: number
}

export interface ChunkRow {
  id: number
  seq: number
  content: string
}

export interface DocumentDetail {
  id: number
  title: string
  doc_type: string
  category: string
  status: string
  article_count: number
  imported_at: string
  articles: ArticleRow[]
  chunks: ChunkRow[]
}

export interface DocumentRow {
  id: number
  title: string
  doc_type: string
  category: string
  status: string
  article_count: number
  imported_at: string
}

export interface SearchResult {
  kind: string
  id: number
  document_id: number
  title: string
  category: string
  doc_type: string
  label: string
  snippet?: string
  content?: string
}

export interface SearchResponse {
  mode: string
  query: string
  results: SearchResult[]
}

export interface ImportResult {
  status: string
  title: string
  document_id: number
  doc_type: string
  article_count: number
  message: string
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init)
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ detail: '' }))
    throw new Error(body.detail || `请求失败（${resp.status}）`)
  }
  return resp.json() as Promise<T>
}

export const api = {
  search(q: string, mode = 'auto'): Promise<SearchResponse> {
    return request<SearchResponse>(
      `/api/search?q=${encodeURIComponent(q)}&mode=${mode}`,
    )
  },
  documents(): Promise<DocumentRow[]> {
    return request<DocumentRow[]>('/api/documents')
  },
  documentDetail(id: number): Promise<DocumentDetail> {
    return request<DocumentDetail>(`/api/documents/${id}`)
  },
  article(id: number): Promise<ArticleDetail> {
    return request<ArticleDetail>(`/api/articles/${id}`)
  },
  upload(files: File[], category: string): Promise<{ results: ImportResult[] }> {
    const fd = new FormData()
    files.forEach((f) => fd.append('files', f))
    if (category.trim()) fd.append('category', category.trim())
    return request('/api/documents', { method: 'POST', body: fd })
  },
  deleteDocument(id: number): Promise<{ ok: boolean }> {
    return request(`/api/documents/${id}`, { method: 'DELETE' })
  },
}
