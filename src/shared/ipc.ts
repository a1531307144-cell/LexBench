// IPC 契约类型：三进程共用的判别联合与结果类型
// 通道命名规则「域:动作」（myresume 模式）；自测专用通道带 __test 前缀且仅开发模式注册

import type { AiTask } from './types'

export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available'; manual: boolean }
  | { type: 'downloading'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; manual: boolean }
  /** 开发版不检查更新（手动检查时回这条，便于开发窗口验证交互） */
  | { type: 'dev-mode' }

export interface UpdateCheckInfo {
  /** 上次自动检查更新是否失败（失败时「关于」里提示是网络问题，避免误以为没有新版） */
  lastAutoCheckFailed: boolean
}

// ---------- 资料库（阶段1） ----------

export interface PickFilesResult {
  canceled: boolean
  /** 仅扩展名白名单内的文件路径 */
  paths: string[]
}

// ---------- 研究工作台（阶段2） ----------

export interface AddItemResult {
  status: 'added' | 'duplicate'
  itemId: number
}

export interface TopicPatch {
  name?: string
  description?: string
}

export type ItemMoveDirection = 'up' | 'down'

// ---------- 阅读模式（阶段2.5） ----------

export interface BookNoteInput {
  contentMd: string
  /** 跨段划选的原文（段落间以 \n 相接） */
  quote: string
  /** 起止锚点：起段 seq + 段内偏移（含）、止段 seq + 段内偏移（不含） */
  startPara: number
  startOffset: number
  endPara: number
  endOffset: number
}

// ---------- 数据包（阶段3 v0.5.0：设备间迁移 + 本地备份） ----------

export interface BackupImportOutcome {
  canceled: boolean
  /** 暂存写入完成、需重启软件生效 */
  needsRestart: boolean
}

// ---------- AI 研究助手（v0.7.0） ----------

/** 保存模型档案：id 缺省=新建；apiKey 留空=保留原值 */
export interface AiProfilePatch {
  id?: number
  name: string
  baseUrl: string
  model: string
  apiKey?: string
}

/** 发起一次 AI 任务；taskId 用于并行任务互不串台 */
export interface AiRunRequest {
  taskId: string
  task: AiTask
  articleId?: number
  question?: string
  /** 指定档案（缺省用当前启用档案） */
  profileId?: number
}

/** 流式进度：delta 为增量文本；done 时携带归档后的消息 id */
export interface AiProgress {
  taskId: string
  delta: string
  done: boolean
  error?: string
  messageId?: number
}

// ---------- 检索（阶段1） ----------

// SearchOutcome / SearchHit / SearchMode 见 types.ts
