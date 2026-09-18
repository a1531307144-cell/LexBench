// IPC 契约类型：三进程共用的判别联合与结果类型（骨架期只有更新通道；业务域随阶段1+ 扩充）

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
