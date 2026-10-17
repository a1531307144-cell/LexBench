import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AiProbePayload,
  AiProfilePatch,
  AiProgress,
  AiRunRequest,
  BackupImportOutcome,
  BookNoteInput,
  UpdateCheckInfo,
  UpdateStatus
} from '../shared/ipc'
import type {
  AiMessageRow,
  AiProfileRow,
  AnnotationRow,
  ArticleDetail,
  BookNoteRow,
  DocGroupRow,
  DocStatus,
  DocType,
  DocumentDetail,
  DocumentRow,
  ExportFormat,
  ExportResult,
  ImportResultItem,
  ImportTypeChoice,
  ReadingProgress,
  SearchMode,
  SearchOutcome
} from '../shared/types'

/**
 * 统一 invoke 包装：Electron 会把主进程抛出的错误包上
 * 「Error invoking remote method '通道名': Error: 」前缀，这里剥掉，
 * 让渲染层错误条直接显示主进程给出的中文文案。
 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((err: unknown) => {
    const raw = err instanceof Error ? err.message : String(err)
    throw new Error(raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ''))
  })
}

/**
 * 渲染进程唯一的能力出口（白名单 API）。
 * 原则：渲染进程不接触任何文件路径；拖放文件仅经 webUtils 取路径交回主进程读取。
 */
const api = {
  app: {
    getVersion: (): Promise<string> => invoke('app:getVersion'),
    /** 数据包导入后重启软件使新数据生效 */
    relaunch: (): Promise<void> => invoke('app:relaunch')
  },
  win: {
    /** 无边框窗口自绘控制按钮（─ □ ✕） */
    minimize: (): void => ipcRenderer.send('win:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('win:maximize'),
    close: (): void => ipcRenderer.send('win:close')
  },
  dialog: {
    /** 选择要导入的文档文件（多选），取消返回 canceled:true */
    pickImportFiles: (): Promise<{ canceled: boolean; paths: string[] }> =>
      invoke('dialog:pickImportFiles'),
    /** 拖放文件的系统路径（Electron 官方 webUtils 方式，路径仅用于交回主进程读取） */
    getPathForFile: (file: File): string => webUtils.getPathForFile(file)
  },
  library: {
    listDocuments: (): Promise<DocumentRow[]> => invoke('library:listDocuments'),
    /** 拖动排序：按传入的 id 顺序整体重排（传当前文件夹里的那批） */
    reorder: (ids: number[]): Promise<void> => invoke('library:reorder', ids),
    /** 本次启动是否刚预置了随包法条（首次启动显示一次性提示用） */
    getSeedInfo: (): Promise<{ justApplied: boolean; count: number }> =>
      invoke('library:getSeedInfo'),
    getDocument: (id: number): Promise<DocumentDetail> =>
      invoke('library:getDocument', id),
    deleteDocument: (id: number): Promise<void> => invoke('library:deleteDocument', id),
    setDocumentStatus: (id: number, status: DocStatus): Promise<void> =>
      invoke('library:setDocumentStatus', id, status),
    /** 导入本地文件（路径来自 dialog:pickImportFiles 或拖放 webUtils），返回逐文件结果；typeChoice='auto' 走自动识别 */
    importDocuments: (paths: string[], category: string, typeChoice: ImportTypeChoice): Promise<ImportResultItem[]> =>
      invoke('library:importDocuments', paths, category, typeChoice),
    /** 把文档归入某分类文件夹（groupId=null 表示移出到未分类） */
    setDocumentGroup: (documentId: number, groupId: number | null): Promise<void> =>
      invoke('library:setDocumentGroup', documentId, groupId),
    /** 法条详情（含同文档前后条） */
    getArticle: (id: number): Promise<ArticleDetail> => invoke('library:getArticle', id),
    /** 条文修正：保存并同步重建全文索引 */
    updateArticle: (id: number, content: string): Promise<void> =>
      invoke('library:updateArticle', id, content)
  },
  search: {
    run: (q: string, mode: SearchMode): Promise<SearchOutcome> =>
      invoke('search:run', q, mode)
  },
  ai: {
    /** 全部模型档案（密钥只回掩码） */
    listProfiles: (): Promise<AiProfileRow[]> => invoke('ai:listProfiles'),
    /** 新建 / 更新档案；apiKey 留空=保留原值 */
    saveProfile: (
      patch: AiProfilePatch
    ): Promise<{ ok: boolean; error?: string; id?: number }> => invoke('ai:saveProfile', patch),
    deleteProfile: (id: number): Promise<void> => invoke('ai:deleteProfile', id),
    setActive: (id: number): Promise<void> => invoke('ai:setActive', id),
    /** 测试连接（可传未保存的表单；apiKey 留空用已存密钥） */
    test: (probe: AiProbePayload): Promise<{ ok: boolean; error?: string; reply?: string }> =>
      invoke('ai:test', probe),
    /** 发起 AI 任务（解读 / 找案例 / 追问），流式增量经 onProgress 回来 */
    run: (req: AiRunRequest): Promise<{ ok: boolean; error?: string }> => invoke('ai:run', req),
    cancel: (taskId: string): Promise<void> => invoke('ai:cancel', taskId),
    /** 订阅流式进度；返回取消订阅函数（组件卸载时必须调用，避免监听器泄漏） */
    onProgress: (cb: (p: AiProgress) => void): (() => void) => {
      const handler = (_e: unknown, p: AiProgress): void => cb(p)
      ipcRenderer.on('ai:progress', handler)
      return () => {
        ipcRenderer.removeListener('ai:progress', handler)
      }
    },
    /** 历史问答（升序）：articleId=null → 全局时间线（通用问答面板）；否则该条文的问答 */
    history: (articleId: number | null): Promise<AiMessageRow[]> => invoke('ai:history', articleId),
    deleteMessage: (id: number): Promise<void> => invoke('ai:deleteMessage', id)
  },
  groups: {
    /** 某类型下的分类文件夹（含文档数）；不传类型则返回全部 */
    list: (docType?: DocType): Promise<DocGroupRow[]> => invoke('groups:list', docType),
    /** 新建分类文件夹（同类型下重名会被拒绝） */
    create: (docType: DocType, name: string): Promise<DocGroupRow> =>
      invoke('groups:create', docType, name),
    rename: (id: number, name: string): Promise<void> => invoke('groups:rename', id, name),
    /** 拖动排序：按传入 id 顺序重排（传同一类型下的完整顺序） */
    reorder: (ids: number[]): Promise<void> => invoke('groups:reorder', ids),
    /** 删除文件夹（其中文档移入「未分类」，不随之删除） */
    remove: (id: number): Promise<void> => invoke('groups:remove', id)
  },
  aiWindow: {
    /** 顶栏开关：开 / 切走独立 AI 窗（已开则隐藏、隐藏则显示、未开则新建） */
    toggle: (): Promise<void> => invoke('aiWindow:toggle'),
    /** AI 窗内调用：点引用 → 请主窗口打开对应法条（AI 窗自己不动，保持独立） */
    openArticle: (articleId: number): Promise<void> => invoke('aiWindow:openArticle', articleId),
    /** 主窗口侧订阅：AI 窗显示/隐藏/关闭（顶栏按钮态同步）；返回退订函数 */
    onVisibility: (cb: (visible: boolean) => void): (() => void) => {
      const handler = (_e: unknown, v: boolean): void => cb(v)
      ipcRenderer.on('aiwin:visibility', handler)
      return () => {
        ipcRenderer.removeListener('aiwin:visibility', handler)
      }
    },
    /** 主窗口侧订阅：AI 窗内点引用的转发；返回退订函数 */
    onOpenArticle: (cb: (articleId: number) => void): (() => void) => {
      const handler = (_e: unknown, id: number): void => cb(id)
      ipcRenderer.on('aiwin:openArticle', handler)
      return () => {
        ipcRenderer.removeListener('aiwin:openArticle', handler)
      }
    }
  },
  annotations: {
    /** 按文档列出全部批注（含 order_index，打开阅读页一次拉全） */
    listByDoc: (documentId: number): Promise<Array<AnnotationRow & { order_index: number }>> =>
      invoke('annotations:listByDoc', documentId),
    create: (payload: {
      articleId: number
      quote: string
      startOffset: number
      endOffset: number
      contentMd: string
    }): Promise<AnnotationRow> => invoke('annotations:create', payload),
    update: (id: number, contentMd: string): Promise<void> =>
      invoke('annotations:update', id, contentMd),
    delete: (id: number): Promise<void> => invoke('annotations:delete', id),
    /** 告知主进程当前是否处于可批注阅读页（右键菜单据此追加「添加批注」） */
    setActive: (active: boolean): void => ipcRenderer.send('annotations:setActive', active),
    /** 主进程菜单「添加批注」点击通知；返回退订函数 */
    onAddRequest: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('annotations:addRequest', handler)
      return () => {
        ipcRenderer.removeListener('annotations:addRequest', handler)
      }
    }
  },
  export: {
    /** 读书笔记导出：引用 + 批注成对列出 */
    saveBookNotes: (documentId: number, format: ExportFormat): Promise<ExportResult> =>
      invoke('export:saveBookNotes', documentId, format),
    /** 仅开发模式存在：跳过对话框直接写到指定路径（自测用） */
    __testSaveBookNotes: (documentId: number, format: ExportFormat, outPath: string): Promise<ExportResult> =>
      invoke('export:__testSaveBookNotes', documentId, format, outPath)
  },
  reading: {
    listBookNotes: (documentId: number): Promise<BookNoteRow[]> =>
      invoke('reading:listBookNotes', documentId),
    createBookNote: (documentId: number, note: BookNoteInput): Promise<BookNoteRow> =>
      invoke('reading:createBookNote', documentId, note),
    updateBookNote: (id: number, contentMd: string): Promise<void> =>
      invoke('reading:updateBookNote', id, contentMd),
    deleteBookNote: (id: number): Promise<void> => invoke('reading:deleteBookNote', id),
    /** 阅读进度；从未读过返回 null */
    getProgress: (documentId: number): Promise<ReadingProgress | null> =>
      invoke('reading:getProgress', documentId),
    saveProgress: (documentId: number, paraIndex: number): Promise<void> =>
      invoke('reading:saveProgress', documentId, paraIndex),
    /** 读取 PDF 原件（优先归档副本，路径失效也能读），供渲染层 pdfjs 渲染页面 */
    getPdfData: (documentId: number): Promise<ArrayBuffer> =>
      invoke('reading:getPdfData', documentId),
    /** PDF 原件本机路径（优先归档副本）——内置 PDF 阅读器以 file:// 加载 */
    getPdfPath: (documentId: number): Promise<string> =>
      invoke('reading:getPdfPath', documentId)
  },
  backup: {
    /** 弹出保存对话框 → 打包全部数据（数据库+原件+AI 配置）→ 写盘 */
    exportAll: (): Promise<ExportResult> => invoke('backup:exportAll'),
    /** 选择数据包 → 校验 → 自动备份当前数据 → 暂存写入；needsRestart=true 时重启软件生效 */
    importAll: (): Promise<BackupImportOutcome> => invoke('backup:importAll'),
    /** 仅开发模式存在：跳过对话框直接按给定路径导出/导入（自测用） */
    __testExport: (outPath: string): Promise<ExportResult> =>
      invoke('backup:__testExport', outPath),
    __testImport: (zipPath: string): Promise<BackupImportOutcome> =>
      invoke('backup:__testImport', zipPath)
  },
  update: {
    check: (): Promise<void> => invoke('update:check'),
    download: (): Promise<void> => invoke('update:download'),
    install: (): Promise<void> => invoke('update:install'),
    /** 「关于」用：上次自动检查是否失败（失败时提示是网络问题，避免误以为没有新版） */
    getCheckInfo: (): Promise<UpdateCheckInfo> => invoke('update:getCheckInfo'),
    /** 仅开发模式存在：置位/复位「自动检查失败」标志（自测用） */
    __testSetCheckFailed: (v: boolean): Promise<void> =>
      invoke('update:__testSetCheckFailed', v),
    /** 订阅更新状态；返回取消订阅函数（组件卸载时必须调用，避免监听器泄漏） */
    onStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
      const handler = (_e: unknown, status: UpdateStatus): void => cb(status)
      ipcRenderer.on('update:status', handler)
      return () => {
        ipcRenderer.removeListener('update:status', handler)
      }
    }
  }
}

export type LexBenchApi = typeof api

contextBridge.exposeInMainWorld('lexbench', api)
