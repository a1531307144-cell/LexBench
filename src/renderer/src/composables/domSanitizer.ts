// 富文本消毒的全局钩子（必须在模块作用域安装——<script setup> 顶层是每个实例一份）
//
// 背景：笔记行内富文本允许 style，但 DOMPurify 不解析 CSS 值，
// `style="position:fixed;inset:0;z-index:2147483647"` 这类声明会真的生效并覆盖整个界面。
// 这里只保留纯展示类声明，并且拒绝 url()/expression/@import。

import DOMPurify from 'dompurify'

/** 允许保留的 CSS 属性（只影响文字外观，不影响布局与层级） */
const ALLOWED_PROPS = new Set([
  'color',
  'background-color',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-decoration-line',
  'font-family'
])

/** 属性值字符白名单：颜色 / 字体名 / 关键字，足以覆盖现有格式工具 */
const SAFE_VALUE = /^[#a-z0-9(),.%\s-]+$/i
const DANGEROUS_VALUE = /url\s*\(|expression\s*\(|javascript:|@import/i

let installed = false

/** 安装一次即可；重复调用无副作用 */
export function installStyleSanitizer(): void {
  if (installed) return
  installed = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return
    const style = node.getAttribute('style')
    if (style == null) return
    const safe = style
      .split(';')
      .map((decl) => decl.trim())
      .filter(Boolean)
      .filter((decl) => {
        const colon = decl.indexOf(':')
        if (colon <= 0) return false
        const prop = decl.slice(0, colon).trim().toLowerCase()
        const value = decl.slice(colon + 1).trim()
        if (!ALLOWED_PROPS.has(prop)) return false
        if (DANGEROUS_VALUE.test(value)) return false
        return SAFE_VALUE.test(value)
      })
      .map((decl) => {
        const colon = decl.indexOf(':')
        return `${decl.slice(0, colon).trim()}: ${decl.slice(colon + 1).trim()}`
      })
      .join('; ')
    if (safe) node.setAttribute('style', safe)
    else node.removeAttribute('style')
  })
}
