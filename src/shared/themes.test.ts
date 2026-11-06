import { describe, expect, it } from 'vitest'
import { APP_THEMES, DEFAULT_THEME_ID, findTheme, themeWindowBackground } from './themes'

const REQUIRED_TOKENS = [
  '--lb-bg',
  '--lb-panel',
  '--lb-panel-2',
  '--lb-chrome',
  '--lb-text',
  '--lb-muted',
  '--lb-border',
  '--lb-border-strong',
  '--lb-hover',
  '--lb-chip',
  '--lb-accent',
  '--lb-accent-2',
  '--lb-grad',
  '--lb-accent-soft',
  '--lb-accent-ring',
  '--lb-accent-glow',
  '--lb-on-accent',
  '--lb-hit',
  '--lb-overlay',
  '--lb-warn-bg',
  '--lb-warn-fg',
  '--lb-err-bg',
  '--lb-err-fg',
  '--lb-ok-bg',
  '--lb-ok-fg',
  '--lb-danger',
  '--lb-danger-strong',
  '--lb-shadow-1',
  '--lb-shadow-2',
  '--lb-shadow-3'
]

describe('app themes', () => {
  it('主题 id 唯一且默认主题存在', () => {
    const ids = APP_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(findTheme(DEFAULT_THEME_ID)).toBeDefined()
  })

  it('每套主题都覆盖全部颜色令牌', () => {
    for (const theme of APP_THEMES) {
      for (const token of REQUIRED_TOKENS) {
        expect(theme.vars[token], `${theme.id} 缺少 ${token}`).toBeTruthy()
      }
    }
  })

  it('浅色/深色分组与色样完整', () => {
    for (const theme of APP_THEMES) {
      expect(theme.group === 'light' || theme.group === 'dark').toBe(true)
      expect(theme.name.length).toBeGreaterThan(0)
      expect(theme.swatches).toHaveLength(3)
      for (const c of theme.swatches) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
    expect(APP_THEMES.some((t) => t.group === 'light')).toBe(true)
    expect(APP_THEMES.some((t) => t.group === 'dark')).toBe(true)
  })

  it('窗口载入底色跟随主题，未知 id 回落到默认浅色', () => {
    expect(themeWindowBackground('night')).toBe('#17121f')
    expect(themeWindowBackground(DEFAULT_THEME_ID)).toBe('#f5f5f7')
    expect(themeWindowBackground('nope')).toBe('#f5f5f7')
    expect(themeWindowBackground(null)).toBe('#f5f5f7')
  })
})
