// 全局配色主题：浅色 / 深色各一套色板，覆盖设计令牌（--lb-*）。
// 主题只改颜色与阴影，不改圆角/字号/间距——保证换肤后版式与手感一致。
// 渲染层通过 <html data-theme> + 内联 CSS 变量应用，主窗口与 AI 独立窗共用。

export interface AppTheme {
  /** 内部标识，持久化到 settings（ui:theme） */
  id: string
  /** 界面显示名（沿用纸张/墨色的中文意象） */
  name: string
  group: 'light' | 'dark'
  /** 卡片色样：主色 / 面板 / 底色 */
  swatches: [string, string, string]
  vars: Record<string, string>
}

/** 浅色主题共用：状态色与阴影 */
const LIGHT_STATUS: Record<string, string> = {
  '--lb-warn-bg': '#fdf3e3',
  '--lb-warn-fg': '#9a6a15',
  '--lb-err-bg': '#fdecea',
  '--lb-err-fg': '#8c2b23',
  '--lb-ok-bg': '#e8f5ec',
  '--lb-ok-fg': '#22763a',
  '--lb-danger': '#ff3b30',
  '--lb-danger-strong': '#e03027',
  '--lb-overlay': 'rgba(0, 0, 0, 0.32)',
  '--lb-shadow-1': '0 1px 2px rgba(20, 24, 38, 0.04), 0 4px 12px rgba(20, 24, 38, 0.06)',
  '--lb-shadow-2': '0 2px 6px rgba(20, 24, 38, 0.05), 0 10px 28px rgba(20, 24, 38, 0.1)',
  '--lb-shadow-3': '0 4px 12px rgba(20, 24, 38, 0.06), 0 24px 64px rgba(20, 24, 38, 0.16)'
}

/** 深色主题共用：状态色与阴影（阴影加深，否则浮层和背景糊在一起） */
const DARK_STATUS: Record<string, string> = {
  '--lb-warn-bg': '#3a3122',
  '--lb-warn-fg': '#e8c277',
  '--lb-err-bg': '#3a2320',
  '--lb-err-fg': '#ff9a92',
  '--lb-ok-bg': '#1e3527',
  '--lb-ok-fg': '#86d6a0',
  '--lb-danger': '#ff453a',
  '--lb-danger-strong': '#e0342b',
  '--lb-overlay': 'rgba(0, 0, 0, 0.55)',
  '--lb-shadow-1': '0 1px 2px rgba(0, 0, 0, 0.35), 0 4px 12px rgba(0, 0, 0, 0.3)',
  '--lb-shadow-2': '0 2px 6px rgba(0, 0, 0, 0.4), 0 10px 28px rgba(0, 0, 0, 0.42)',
  '--lb-shadow-3': '0 4px 12px rgba(0, 0, 0, 0.45), 0 24px 64px rgba(0, 0, 0, 0.55)'
}

interface LightPalette {
  bg: string
  panel: string
  panel2: string
  chrome: string
  text: string
  muted: string
  border: string
  borderStrong: string
  hover: string
  chip: string
  accent: string
  accent2: string
  soft: string
  ring: string
  glow: string
  hit: string
  onAccent?: string
}

function lightVars(p: LightPalette): Record<string, string> {
  return {
    '--lb-bg': p.bg,
    '--lb-panel': p.panel,
    '--lb-panel-2': p.panel2,
    '--lb-chrome': p.chrome,
    '--lb-text': p.text,
    '--lb-muted': p.muted,
    '--lb-border': p.border,
    '--lb-border-strong': p.borderStrong,
    '--lb-hover': p.hover,
    '--lb-chip': p.chip,
    '--lb-accent': p.accent,
    '--lb-accent-2': p.accent2,
    '--lb-grad': p.accent,
    '--lb-accent-soft': p.soft,
    '--lb-accent-ring': p.ring,
    '--lb-accent-glow': p.glow,
    '--lb-accent-wash': p.soft,
    '--lb-accent-selection': p.glow,
    '--lb-on-accent': p.onAccent ?? '#ffffff',
    '--lb-hit': p.hit,
    '--lb-overlay-soft': 'rgba(0, 0, 0, 0.25)',
    '--lb-scrollbar': 'rgba(0, 0, 0, 0.18)',
    '--lb-scrollbar-hover': 'rgba(0, 0, 0, 0.32)',
    ...LIGHT_STATUS
  }
}

interface DarkPalette {
  bg: string
  panel: string
  panel2: string
  chrome: string
  text: string
  muted: string
  border: string
  borderStrong: string
  hover: string
  chip: string
  accent: string
  accent2: string
  soft: string
  ring: string
  glow: string
  hit: string
  onAccent: string
}

function darkVars(p: DarkPalette): Record<string, string> {
  return {
    '--lb-bg': p.bg,
    '--lb-panel': p.panel,
    '--lb-panel-2': p.panel2,
    '--lb-chrome': p.chrome,
    '--lb-text': p.text,
    '--lb-muted': p.muted,
    '--lb-border': p.border,
    '--lb-border-strong': p.borderStrong,
    '--lb-hover': p.hover,
    '--lb-chip': p.chip,
    '--lb-accent': p.accent,
    '--lb-accent-2': p.accent2,
    '--lb-grad': p.accent,
    '--lb-accent-soft': p.soft,
    '--lb-accent-ring': p.ring,
    '--lb-accent-glow': p.glow,
    '--lb-accent-wash': p.soft,
    '--lb-accent-selection': p.glow,
    '--lb-on-accent': p.onAccent,
    '--lb-hit': p.hit,
    '--lb-overlay-soft': 'rgba(0, 0, 0, 0.45)',
    '--lb-scrollbar': 'rgba(255, 255, 255, 0.16)',
    '--lb-scrollbar-hover': 'rgba(255, 255, 255, 0.3)',
    ...DARK_STATUS
  }
}

export const APP_THEMES: AppTheme[] = [
  // ---------- 浅色：基础纸张 ----------
  {
    id: 'pure',
    name: '纯境',
    group: 'light',
    swatches: ['#0071e3', '#ffffff', '#f5f5f7'],
    vars: lightVars({
      bg: '#f5f5f7',
      panel: '#ffffff',
      panel2: '#fbfbfe',
      chrome: '#fbfbfd',
      text: '#1d1d1f',
      muted: '#86868b',
      border: 'rgba(0, 0, 0, 0.07)',
      borderStrong: 'rgba(0, 0, 0, 0.12)',
      hover: '#f0f0f6',
      chip: '#e8e8ed',
      accent: '#0071e3',
      accent2: '#0077ed',
      soft: 'rgba(0, 113, 227, 0.1)',
      ring: 'rgba(0, 113, 227, 0.55)',
      glow: 'rgba(0, 113, 227, 0.14)',
      hit: 'rgba(0, 113, 227, 0.14)'
    })
  },
  {
    id: 'outline',
    name: '明线',
    group: 'light',
    swatches: ['#26262b', '#ffffff', '#f2f2f4'],
    vars: lightVars({
      bg: '#f2f2f4',
      panel: '#ffffff',
      panel2: '#fafafa',
      chrome: '#f7f7f8',
      text: '#17171a',
      muted: '#77777d',
      border: 'rgba(0, 0, 0, 0.12)',
      borderStrong: 'rgba(0, 0, 0, 0.22)',
      hover: '#ececef',
      chip: '#e7e7ea',
      accent: '#26262b',
      accent2: '#3a3a41',
      soft: 'rgba(38, 38, 43, 0.08)',
      ring: 'rgba(38, 38, 43, 0.5)',
      glow: 'rgba(38, 38, 43, 0.12)',
      hit: 'rgba(38, 38, 43, 0.1)'
    })
  },
  {
    id: 'plain',
    name: '素页',
    group: 'light',
    swatches: ['#8a6a45', '#fbf7ef', '#f0ebe2'],
    vars: lightVars({
      bg: '#f0ebe2',
      panel: '#fbf7ef',
      panel2: '#f6f1e7',
      chrome: '#f5f0e7',
      text: '#2c2721',
      muted: '#857c6e',
      border: 'rgba(60, 45, 25, 0.1)',
      borderStrong: 'rgba(60, 45, 25, 0.18)',
      hover: '#efe8dc',
      chip: '#e9e0d2',
      accent: '#8a6a45',
      accent2: '#a07d55',
      soft: 'rgba(138, 106, 69, 0.12)',
      ring: 'rgba(138, 106, 69, 0.5)',
      glow: 'rgba(138, 106, 69, 0.14)',
      hit: 'rgba(138, 106, 69, 0.15)'
    })
  },

  // ---------- 浅色：带色纸张 ----------
  {
    id: 'ink',
    name: '墨稿',
    group: 'light',
    swatches: ['#4d4238', '#f7f4ef', '#ebe7e1'],
    vars: lightVars({
      bg: '#ebe7e1',
      panel: '#f7f4ef',
      panel2: '#f1ede7',
      chrome: '#f0ece6',
      text: '#2a2622',
      muted: '#807a72',
      border: 'rgba(40, 32, 24, 0.1)',
      borderStrong: 'rgba(40, 32, 24, 0.18)',
      hover: '#e6e1da',
      chip: '#e2ddd5',
      accent: '#4d4238',
      accent2: '#635344',
      soft: 'rgba(77, 66, 56, 0.1)',
      ring: 'rgba(77, 66, 56, 0.5)',
      glow: 'rgba(77, 66, 56, 0.13)',
      hit: 'rgba(77, 66, 56, 0.14)'
    })
  },
  {
    id: 'ganpi',
    name: '雁皮',
    group: 'light',
    swatches: ['#9a6a4f', '#fdf6ee', '#f3e6da'],
    vars: lightVars({
      bg: '#f3e6da',
      panel: '#fdf6ee',
      panel2: '#f9efe4',
      chrome: '#f7ecdf',
      text: '#3a2c24',
      muted: '#8d796b',
      border: 'rgba(90, 55, 35, 0.1)',
      borderStrong: 'rgba(90, 55, 35, 0.18)',
      hover: '#efe0d2',
      chip: '#eadbcc',
      accent: '#9a6a4f',
      accent2: '#ab7b5e',
      soft: 'rgba(154, 106, 79, 0.12)',
      ring: 'rgba(154, 106, 79, 0.5)',
      glow: 'rgba(154, 106, 79, 0.14)',
      hit: 'rgba(154, 106, 79, 0.15)'
    })
  },
  {
    id: 'mist',
    name: '薄雾',
    group: 'light',
    swatches: ['#4f7a99', '#f8fbfd', '#e9eff4'],
    vars: lightVars({
      bg: '#e9eff4',
      panel: '#f8fbfd',
      panel2: '#f1f6f9',
      chrome: '#eff4f8',
      text: '#1f2a33',
      muted: '#788a97',
      border: 'rgba(30, 60, 85, 0.1)',
      borderStrong: 'rgba(30, 60, 85, 0.18)',
      hover: '#e3ebf1',
      chip: '#dde7ee',
      accent: '#4f7a99',
      accent2: '#6189a7',
      soft: 'rgba(79, 122, 153, 0.12)',
      ring: 'rgba(79, 122, 153, 0.5)',
      glow: 'rgba(79, 122, 153, 0.14)',
      hit: 'rgba(79, 122, 153, 0.15)'
    })
  },
  {
    id: 'breeze',
    name: '清风',
    group: 'light',
    swatches: ['#3f8a4d', '#f8fcf6', '#e8f3e5'],
    vars: lightVars({
      bg: '#e8f3e5',
      panel: '#f8fcf6',
      panel2: '#f1f8ee',
      chrome: '#eef7eb',
      text: '#1f2a1e',
      muted: '#7a8b77',
      border: 'rgba(35, 70, 35, 0.1)',
      borderStrong: 'rgba(35, 70, 35, 0.18)',
      hover: '#e0eddc',
      chip: '#d9e8d5',
      accent: '#3f8a4d',
      accent2: '#4f9b5d',
      soft: 'rgba(63, 138, 77, 0.12)',
      ring: 'rgba(63, 138, 77, 0.5)',
      glow: 'rgba(63, 138, 77, 0.14)',
      hit: 'rgba(63, 138, 77, 0.15)'
    })
  },
  {
    id: 'pulse',
    name: '脉搏',
    group: 'light',
    swatches: ['#c8612c', '#fffaf6', '#fdeee6'],
    vars: lightVars({
      bg: '#fdeee6',
      panel: '#fffaf6',
      panel2: '#fdf2ea',
      chrome: '#fcefe7',
      text: '#2f241f',
      muted: '#8f7a6e',
      border: 'rgba(90, 50, 25, 0.1)',
      borderStrong: 'rgba(90, 50, 25, 0.18)',
      hover: '#fbe4d8',
      chip: '#f6ddcf',
      accent: '#c8612c',
      accent2: '#dd7038',
      soft: 'rgba(200, 97, 44, 0.12)',
      ring: 'rgba(200, 97, 44, 0.5)',
      glow: 'rgba(200, 97, 44, 0.14)',
      hit: 'rgba(200, 97, 44, 0.15)'
    })
  },
  {
    id: 'voyage',
    name: '远航',
    group: 'light',
    swatches: ['#2670cc', '#f8fbff', '#e6effb'],
    vars: lightVars({
      bg: '#e6effb',
      panel: '#f8fbff',
      panel2: '#eff5fd',
      chrome: '#edf4fc',
      text: '#1c2735',
      muted: '#7288a1',
      border: 'rgba(25, 55, 95, 0.1)',
      borderStrong: 'rgba(25, 55, 95, 0.18)',
      hover: '#deeaf8',
      chip: '#d8e5f4',
      accent: '#2670cc',
      accent2: '#3680db',
      soft: 'rgba(38, 112, 204, 0.12)',
      ring: 'rgba(38, 112, 204, 0.5)',
      glow: 'rgba(38, 112, 204, 0.14)',
      hit: 'rgba(38, 112, 204, 0.15)'
    })
  },

  // ---------- 深色 ----------
  {
    id: 'focus',
    name: '焦点',
    group: 'dark',
    swatches: ['#e8e8ed', '#232326', '#18181a'],
    vars: darkVars({
      bg: '#18181a',
      panel: '#232326',
      panel2: '#2a2a2e',
      chrome: '#1d1d20',
      text: '#f2f2f4',
      muted: '#9a9aa2',
      border: 'rgba(255, 255, 255, 0.09)',
      borderStrong: 'rgba(255, 255, 255, 0.17)',
      hover: 'rgba(255, 255, 255, 0.07)',
      chip: '#323236',
      accent: '#e8e8ed',
      accent2: '#f5f5f7',
      soft: 'rgba(232, 232, 237, 0.12)',
      ring: 'rgba(232, 232, 237, 0.5)',
      glow: 'rgba(232, 232, 237, 0.16)',
      hit: 'rgba(232, 232, 237, 0.18)',
      onAccent: '#1b1b1d'
    })
  },
  {
    id: 'abyss',
    name: '深渊',
    group: 'dark',
    swatches: ['#8fb3ee', '#182235', '#0f1624'],
    vars: darkVars({
      bg: '#0f1624',
      panel: '#182235',
      panel2: '#1e2a40',
      chrome: '#131b2b',
      text: '#e8eefc',
      muted: '#8ea0bf',
      border: 'rgba(255, 255, 255, 0.09)',
      borderStrong: 'rgba(255, 255, 255, 0.17)',
      hover: 'rgba(255, 255, 255, 0.07)',
      chip: '#243149',
      accent: '#8fb3ee',
      accent2: '#a6c4f5',
      soft: 'rgba(143, 179, 238, 0.14)',
      ring: 'rgba(143, 179, 238, 0.5)',
      glow: 'rgba(143, 179, 238, 0.18)',
      hit: 'rgba(143, 179, 238, 0.2)',
      onAccent: '#101827'
    })
  },
  {
    id: 'night',
    name: '夜图',
    group: 'dark',
    swatches: ['#b79ae0', '#211a2d', '#17121f'],
    vars: darkVars({
      bg: '#17121f',
      panel: '#211a2d',
      panel2: '#282037',
      chrome: '#1b1525',
      text: '#ede8f6',
      muted: '#a397b8',
      border: 'rgba(255, 255, 255, 0.09)',
      borderStrong: 'rgba(255, 255, 255, 0.17)',
      hover: 'rgba(255, 255, 255, 0.07)',
      chip: '#302642',
      accent: '#b79ae0',
      accent2: '#c9b1ee',
      soft: 'rgba(183, 154, 224, 0.14)',
      ring: 'rgba(183, 154, 224, 0.5)',
      glow: 'rgba(183, 154, 224, 0.18)',
      hit: 'rgba(183, 154, 224, 0.2)',
      onAccent: '#1a1422'
    })
  },
  {
    id: 'forest',
    name: '秘林',
    group: 'dark',
    swatches: ['#a8bd6d', '#21271d', '#171b15'],
    vars: darkVars({
      bg: '#171b15',
      panel: '#21271d',
      panel2: '#272f23',
      chrome: '#1a1f18',
      text: '#e9eee4',
      muted: '#9ca893',
      border: 'rgba(255, 255, 255, 0.09)',
      borderStrong: 'rgba(255, 255, 255, 0.17)',
      hover: 'rgba(255, 255, 255, 0.07)',
      chip: '#2e3729',
      accent: '#a8bd6d',
      accent2: '#bcd086',
      soft: 'rgba(168, 189, 109, 0.14)',
      ring: 'rgba(168, 189, 109, 0.5)',
      glow: 'rgba(168, 189, 109, 0.18)',
      hit: 'rgba(168, 189, 109, 0.2)',
      onAccent: '#182013'
    })
  },
  {
    id: 'volcano',
    name: '火山',
    group: 'dark',
    swatches: ['#dd8155', '#2a1d19', '#1e1412'],
    vars: darkVars({
      bg: '#1e1412',
      panel: '#2a1d19',
      panel2: '#31231e',
      chrome: '#221715',
      text: '#f5e9e4',
      muted: '#b0948a',
      border: 'rgba(255, 255, 255, 0.09)',
      borderStrong: 'rgba(255, 255, 255, 0.17)',
      hover: 'rgba(255, 255, 255, 0.07)',
      chip: '#3a2923',
      accent: '#dd8155',
      accent2: '#eca073',
      soft: 'rgba(221, 129, 85, 0.14)',
      ring: 'rgba(221, 129, 85, 0.5)',
      glow: 'rgba(221, 129, 85, 0.18)',
      hit: 'rgba(221, 129, 85, 0.2)',
      onAccent: '#22100a'
    })
  },
  {
    id: 'lake',
    name: '梦湖',
    group: 'dark',
    swatches: ['#6cc5b9', '#172927', '#0f1d1c'],
    vars: darkVars({
      bg: '#0f1d1c',
      panel: '#172927',
      panel2: '#1d322f',
      chrome: '#122320',
      text: '#e3f2ef',
      muted: '#8fb2ac',
      border: 'rgba(255, 255, 255, 0.09)',
      borderStrong: 'rgba(255, 255, 255, 0.17)',
      hover: 'rgba(255, 255, 255, 0.07)',
      chip: '#233b38',
      accent: '#6cc5b9',
      accent2: '#8ad8cd',
      soft: 'rgba(108, 197, 185, 0.14)',
      ring: 'rgba(108, 197, 185, 0.5)',
      glow: 'rgba(108, 197, 185, 0.18)',
      hit: 'rgba(108, 197, 185, 0.2)',
      onAccent: '#0c1a18'
    })
  }
]

export const DEFAULT_THEME_ID = 'pure'

export function findTheme(id: string | null | undefined): AppTheme | undefined {
  return APP_THEMES.find((t) => t.id === id)
}

/** 窗口载入前的底色（BrowserWindow backgroundColor）：避免深色主题启动时闪一下浅色 */
export function themeWindowBackground(id: string | null | undefined): string {
  return findTheme(id)?.vars['--lb-bg'] ?? '#f5f5f7'
}
