import { describe, expect, it } from 'vitest'
import {
  escapeHtml,
  hasInlineFormatting,
  htmlFromPlainText,
  htmlToMarkdownInline,
  nodeMarkdownText,
  normalizeEditorHtml,
  plainTextFromHtml
} from './outlineRichText'

describe('outlineRichText 纯文本镜像', () => {
  it('HTML → 纯文本（br/实体/零宽）', () => {
    expect(plainTextFromHtml('甲<br>乙&lt;丙&#10;丁​')).toBe('甲\n乙<丙\n丁')
    expect(plainTextFromHtml('<div>一</div><div>二</div>')).toBe('一\n二')
  })

  it('纯文本 → HTML 转义换行', () => {
    expect(htmlFromPlainText('a<b\nc')).toBe('a&lt;b<br>c')
  })

  it('escapeHtml 覆盖四个字符', () => {
    expect(escapeHtml('&<>"')).toBe('&amp;&lt;&gt;&quot;')
  })
})

describe('outlineRichText 格式判定与 Markdown', () => {
  it('纯文本不触发存储', () => {
    expect(hasInlineFormatting('第一行', '第一行')).toBe(false)
    expect(hasInlineFormatting('<span>第一行</span>', '第一行')).toBe(false)
    expect(hasInlineFormatting('第一行<br>', '第一行')).toBe(false)
  })

  it('行内样式触发存储', () => {
    expect(hasInlineFormatting('<b>重点</b>', '重点')).toBe(true)
    expect(hasInlineFormatting('<span style="background-color: rgb(255, 255, 0)">重点</span>', '重点')).toBe(true)
  })

  it('HTML → Markdown 行内映射', () => {
    expect(htmlToMarkdownInline('<b>粗</b><i>斜</i><s>删</s>')).toBe('**粗***斜*~~删~~')
    expect(htmlToMarkdownInline('<code>x = 1</code>')).toBe('`x = 1`')
    expect(htmlToMarkdownInline('<a href="https://example.com/a?b=1&amp;c=2">链接</a>')).toBe(
      '[链接](https://example.com/a?b=1&c=2)'
    )
    expect(htmlToMarkdownInline('<span style="color: red">红</span>字')).toBe('红字')
  })

  it('嵌套格式递归', () => {
    expect(htmlToMarkdownInline('<b>粗<i>斜</i></b>')).toBe('**粗*斜***')
  })

  it('nodeMarkdownText 无 html 时回落 text', () => {
    expect(nodeMarkdownText({ text: '纯文本' })).toBe('纯文本')
    expect(nodeMarkdownText({ text: '重点', html: '<b>重点</b>' })).toBe('**重点**')
  })

  it('normalizeEditorHtml 去噪声属性、保留白名单样式', () => {
    expect(normalizeEditorHtml('<b id="x" contenteditable="true">粗</b>')).toBe('<b>粗</b>')
    expect(normalizeEditorHtml('<span style="color: red">红</span>')).toBe('<span style="color: red">红</span>')
    expect(normalizeEditorHtml('<a href="https://x" target="_blank">链</a>')).toBe('<a href="https://x">链</a>')
  })
})
