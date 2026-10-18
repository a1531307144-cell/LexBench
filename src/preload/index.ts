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
  ImportPreviewItem,
  ImportResultItem,
  ImportRunItem,
  ImportTypeChoice,
  NoteGroupRow,
  OutlineListRow,
  OutlineRow,
  ReadingProgress,
  SearchMode,
  SearchOutcome,
  StarredArticleRow
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
  clipboard: {
    /** 「复制引用」：plain 干净文本 + html 带 ref 元数据（笔记粘贴时生成引用节点） */
    writeRef: (payload: { text: string; html: string }): Promise<void> =>
      invoke('clipboard:writeRef', payload)
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
  outlines: {
    /** 笔记列表（更新时间序；keyword 标题过滤；groupId 分类过滤——null=只看未分类，undefined=全部） */
    list: (keyword?: string, groupId?: number | null): Promise<OutlineListRow[]> =>
      invoke('outlines:list', keyword, groupId),
    get: (id: number): Promise<OutlineRow> => invoke('outlines:get', id),
    create: (title: string, groupId?: number | null): Promise<OutlineRow> =>
      invoke('outlines:create', title, groupId),
    /** 归类 / 记住视图（与树保存互不覆盖） */
    setGroup: (id: number, groupId: number | null): Promise<void> =>
      invoke('outlines:setGroup', id, groupId),
    setViewMode: (id: number, mode: string): Promise<void> =>
      invoke('outlines:setViewMode', id, mode),
    /** 自动保存（编辑器防抖整树落库）；title 传了顺带改名 */
    save: (id: number, tree: string, title?: string): Promise<void> =>
      invoke('outlines:save', id, tree, title),
    remove: (id: number): Promise<void> => invoke('outlines:delete', id),
    /** 导出笔记（md/docx）：弹保存对话框，取消返回 {canceled:true} */
    export: (id: number, format: ExportFormat): Promise<ExportResult> =>
      invoke('outlines:export', id, format),
    /** 通用大纲导入（业界通用格式）：选文件 → 预检（解析不落库）→ runImport 执行 */
    pickImportFiles: (): Promise<{ canceled: boolean; paths: string[] }> =>
      invoke('outlines:pickImportFiles'),
    previewImport: (paths: string[]): Promise<ImportPreviewItem[]> =>
      invoke('outlines:previewImport', paths),
    /** 执行导入；duplicates：'skip'=重复跳过 / 'append'=仍然导入（标题加后缀） */
    runImport: (paths: string[], duplicates: string): Promise<ImportRunItem[]> =>
      invoke('outlines:runImport', paths, duplicates),
    /** 仅开发模式存在：跳过对话框直接写到指定路径（自测用） */
    __testExport: (id: number, format: ExportFormat, outPath: string): Promise<ExportResult> =>
      invoke('outlines:__testExport', id, format, outPath),
    /** 星标法条列表（笔记库左列入口） */
    listStarred: (): Promise<StarredArticleRow[]> => invoke('articles:listStarred'),
    /** 点亮/熄灭法条星标 */
    setStarred: (articleId: number, starred: boolean): Promise<void> =>
      invoke('articles:setStarred', articleId, starred),
    /** 引用行按下右键时先报 ref（主进程菜单据此追加「在文档库打开来源」） */
    setRefContext: (ref: { docId: number; articleId: number } | null): void =>
      ipcRenderer.send('outlines:setRefContext', ref),
    /** 主菜单「在文档库打开来源」点击通知；返回退订函数 */
    onOpenSource: (cb: (ref: { docId: number; articleId: number }) => void): (() => void) => {
      const handler = (_e: unknown, ref: { docId: number; articleId: number }): void => cb(ref)
      ipcRenderer.on('outlines:openSource', handler)
      return () => {
        ipcRenderer.removeListener('outlines:openSource', handler)
      }
    }
  },
  noteGroups: {
    list: (): Promise<NoteGroupRow[]> => invoke('noteGroups:list'),
    create: (name: string): Promise<NoteGroupRow> => invoke('noteGroups:create', name),
    rename: (id: number, name: string): Promise<void> => invoke('noteGroups:rename', id, name),
    reorder: (ids: number[]): Promise<void> => invoke('noteGroups:reorder', ids),
    /** 删除分类：其中笔记归「未分类」 */
    remove: (id: number): Promise<void> => invoke('noteGroups:remove', id)
  },
  attachments: {
    /** 贴图保存：base64（无 data: 前缀）+ 扩展名 → attachments 相对文件名 */
    saveImage: (b64: string, ext: string): Promise<string> =>
      invoke('attachments:saveImage', b64, ext),
    /** 贴图读取：文件名 → 字节流（渲染层转 Blob URL 显示） */
    read: (fileName: string): Promise<ArrayBuffer> => invoke('attachments:read', fileName)
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
      invoke('reading:getPdfPath', documentId),
    /** 主进程菜单「复制引用」点击通知（法规阅读页有选区时出现）；返回退订函数 */
    onCopyRefRequest: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('reading:copyRefRequest', handler)
      return () => {
        ipcRenderer.removeListener('reading:copyRefRequest', handler)
      }
    }
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
