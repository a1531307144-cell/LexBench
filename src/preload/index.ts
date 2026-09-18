import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { UpdateCheckInfo, UpdateStatus } from '../shared/ipc'
import type {
  ArticleDetail,
  DocStatus,
  DocumentDetail,
  DocumentRow,
  ImportResultItem,
  SearchMode,
  SearchOutcome
} from '../shared/types'

/**
 * 渲染进程唯一的能力出口（白名单 API）。
 * 原则：渲染进程不接触任何文件路径；拖放文件仅经 webUtils 取路径交回主进程读取。
 */
const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion')
  },
  dialog: {
    /** 选择要导入的文档文件（多选），取消返回 canceled:true */
    pickImportFiles: (): Promise<{ canceled: boolean; paths: string[] }> =>
      ipcRenderer.invoke('dialog:pickImportFiles'),
    /** 拖放文件的系统路径（Electron 官方 webUtils 方式，路径仅用于交回主进程读取） */
    getPathForFile: (file: File): string => webUtils.getPathForFile(file)
  },
  library: {
    listDocuments: (): Promise<DocumentRow[]> => ipcRenderer.invoke('library:listDocuments'),
    getDocument: (id: number): Promise<DocumentDetail> =>
      ipcRenderer.invoke('library:getDocument', id),
    deleteDocument: (id: number): Promise<void> => ipcRenderer.invoke('library:deleteDocument', id),
    setDocumentStatus: (id: number, status: DocStatus): Promise<void> =>
      ipcRenderer.invoke('library:setDocumentStatus', id, status),
    /** 导入本地文件（路径来自 dialog:pickImportFiles 或拖放 webUtils），返回逐文件结果 */
    importDocuments: (paths: string[], category: string): Promise<ImportResultItem[]> =>
      ipcRenderer.invoke('library:importDocuments', paths, category),
    /** 法条详情（含同文档前后条） */
    getArticle: (id: number): Promise<ArticleDetail> => ipcRenderer.invoke('library:getArticle', id),
    /** 条文修正：保存并同步重建全文索引 */
    updateArticle: (id: number, content: string): Promise<void> =>
      ipcRenderer.invoke('library:updateArticle', id, content)
  },
  search: {
    run: (q: string, mode: SearchMode): Promise<SearchOutcome> =>
      ipcRenderer.invoke('search:run', q, mode)
  },
  update: {
    check: (): Promise<void> => ipcRenderer.invoke('update:check'),
    download: (): Promise<void> => ipcRenderer.invoke('update:download'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    /** 「关于」用：上次自动检查是否失败（失败时提示是网络问题，避免误以为没有新版） */
    getCheckInfo: (): Promise<UpdateCheckInfo> => ipcRenderer.invoke('update:getCheckInfo'),
    /** 仅开发模式存在：置位/复位「自动检查失败」标志（自测用） */
    __testSetCheckFailed: (v: boolean): Promise<void> =>
      ipcRenderer.invoke('update:__testSetCheckFailed', v),
    onStatus: (cb: (status: UpdateStatus) => void): void => {
      ipcRenderer.on('update:status', (_e, status: UpdateStatus) => cb(status))
    }
  }
}

export type LexBenchApi = typeof api

contextBridge.exposeInMainWorld('lexbench', api)
