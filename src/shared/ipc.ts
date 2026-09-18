// IPC 契约类型：三进程共用的判别联合与结果类型
// 通道命名规则「域:动作」（myresume 模式）；自测专用通道带 __test 前缀且仅开发模式注册

export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available'; manual: boolean }
  | { type: 'downloading'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; manual: boolean }

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

// ---------- 检索（阶段1） ----------

// SearchOutcome / SearchHit / SearchMode 见 types.ts
