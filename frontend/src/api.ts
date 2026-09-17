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

export interface TopicRow {
  id: number
  name: string
  description: string
  item_count: number
  note_count: number
  updated_at: string
}

export interface TopicItemRow {
  item_id: number
  article_id: number
  order_index: number
  label: string
  article_no: number
  title: string
  category: string
  doc_type: string
  branch: string
  chapter: string
  section: string
  content: string
}

export interface NoteRow {
  id: number
  topic_id: number
  article_id: number | null
  content_md: string
  created_at: string
  updated_at: string
}

export interface TopicDetail {
  id: number
  name: string
  description: string
  items: TopicItemRow[]
  notes: NoteRow[]
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
  updateArticle(id: number, content: string): Promise<{ ok: boolean }> {
    return request(`/api/articles/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  },
  updateDocumentStatus(id: number, status: string): Promise<{ ok: boolean }> {
    return request(`/api/documents/${id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
  },
  topics(): Promise<TopicRow[]> {
    return request<TopicRow[]>('/api/topics')
  },
  createTopic(name: string, description = ''): Promise<TopicRow> {
    return request<TopicRow>('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    })
  },
  topicDetail(id: number): Promise<TopicDetail> {
    return request<TopicDetail>(`/api/topics/${id}`)
  },
  updateTopic(id: number, body: { name?: string; description?: string }): Promise<{ ok: boolean }> {
    return request(`/api/topics/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },
  deleteTopic(id: number): Promise<{ ok: boolean }> {
    return request(`/api/topics/${id}`, { method: 'DELETE' })
  },
  addFavorite(topicId: number, articleId: number): Promise<{ status: string; item_id: number }> {
    return request(`/api/topics/${topicId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ article_id: articleId }),
    })
  },
  removeFavorite(topicId: number, articleId: number): Promise<{ ok: boolean }> {
    return request(`/api/topics/${topicId}/items/${articleId}`, { method: 'DELETE' })
  },
  createNote(body: { topic_id: number; article_id?: number | null; content_md: string }): Promise<NoteRow> {
    return request<NoteRow>('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },
  updateNote(id: number, contentMd: string): Promise<{ ok: boolean }> {
    return request(`/api/notes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_md: contentMd }),
    })
  },
  deleteNote(id: number): Promise<{ ok: boolean }> {
    return request(`/api/notes/${id}`, { method: 'DELETE' })
  },
  exportTopicUrl(id: number, format: 'md' | 'docx'): string {
    return `/api/topics/${id}/export?format=${format}`
  },
}
