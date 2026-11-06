// 应用主题（全局配色）：本地缓存即时生效 + settings 表持久化。
// - 启动时先读 localStorage 同步上色，避免闪一下默认色；
// - 随后与 settings 对齐（数据包跨机恢复后以设置为准）；
// - 主窗口与 AI 独立窗共用同一份缓存，storage 事件让另一窗口实时跟随换肤。

import { ref } from 'vue'
import { APP_THEMES, DEFAULT_THEME_ID, findTheme } from '@shared/themes'

export const THEME_STORAGE_KEY = 'lexbench:theme'
export const THEME_SETTING_KEY = 'ui:theme'

function readCache(): string {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) ?? DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
}

/** 当前主题 id（响应式，供主题选择器高亮） */
export const activeThemeId = ref(readCache())

/** 把主题变量写到 <html>：内联变量覆盖 tokens.css 的默认值 */
export function applyTheme(id: string): void {
  const theme = findTheme(id) ?? findTheme(DEFAULT_THEME_ID) ?? APP_THEMES[0]!
  const root = document.documentElement
  root.dataset.theme = theme.id
  root.style.colorScheme = theme.group
  for (const [name, value] of Object.entries(theme.vars)) {
    root.style.setProperty(name, value)
  }
}

/** 启动同步上色（main.ts 在 mount 前调用） */
export function bootstrapTheme(): void {
  applyTheme(readCache())
}

/** 用户选主题：立即生效并写入缓存 + 设置 */
export function setTheme(id: string): void {
  if (!findTheme(id)) return
  activeThemeId.value = id
  applyTheme(id)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id)
  } catch {
    /* 缓存写不进去不影响本次使用 */
  }
  void window.lexbench?.settings.set(THEME_SETTING_KEY, id).catch(() => {})
}

/** 与设置表对齐（数据包恢复/换机后设置可能比缓存新） */
export async function syncThemeFromSettings(): Promise<void> {
  try {
    const saved = await window.lexbench.settings.get(THEME_SETTING_KEY)
    if (saved && findTheme(saved)) {
      if (saved !== activeThemeId.value) {
        activeThemeId.value = saved
        applyTheme(saved)
      }
      try {
        localStorage.setItem(THEME_STORAGE_KEY, saved)
      } catch {
        /* ignore */
      }
    } else {
      // 首次运行：把当前缓存写进设置，保证之后导出数据包时带上
      void window.lexbench.settings.set(THEME_SETTING_KEY, activeThemeId.value).catch(() => {})
    }
  } catch {
    /* 设置不可读时沿用缓存 */
  }
}

/** 另一窗口换肤时同步（同一分区 localStorage 的 storage 事件） */
export function watchThemeAcrossWindows(): () => void {
  const onStorage = (e: StorageEvent): void => {
    if (e.key !== THEME_STORAGE_KEY) return
    const id = e.newValue ?? DEFAULT_THEME_ID
    if (id === activeThemeId.value) return
    if (!findTheme(id)) return
    activeThemeId.value = id
    applyTheme(id)
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
