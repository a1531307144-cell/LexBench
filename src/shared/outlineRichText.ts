// 大纲行内富文本的纯函数层：纯文本镜像、HTML→Markdown、有无格式判定。
// 渲染层只允许白名单标签（见 OutlineTextEditor 的消毒配置）；这里不依赖 DOM。

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code)
      return whole
    }
    return ENTITY_MAP[body.toLowerCase()] ?? whole
  })
}

/** HTML → 纯文本（<br>/块级标签转换行；去掉零宽占位） */
export function plainTextFromHtml(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  return decodeHtmlEntities(text).replace(/​/g, '').replace(/\n$/, '')
}

/** 纯文本 → 可编辑 HTML（换行用 <br>） */
export function htmlFromPlainText(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>')
}

/** 清理编辑器的浏览器噪声，便于比较/存储 */
export function normalizeEditorHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>$/i, '')
    .replace(/​/g, '')
    .replace(/<([a-z][a-z0-9-]*)\s+[^>]*?>/gi, (whole, tag: string) => {
      // 保留 href/style；其余属性（contenteditable/id/class 等）不进存储
      const t = tag.toLowerCase()
      if (t === 'a') {
        const href = /href="([^"]*)"/i.exec(whole)?.[1]
        return href ? `<a href="${href}">` : '<a>'
      }
      const style = /style="([^"]*)"/i.exec(whole)?.[1]
      return style ? `<${t} style="${style}">` : `<${t}>`
    })
    .replace(/ style="(\s*)"/gi, '')
}

const FORMAT_TAGS = /<(b|strong|i|em|u|s|strike|del|a|code|span|font|mark)\b/i

/** 判断这行是否真的含行内格式（纯文本就不存 html，历史数据也更省） */
export function hasInlineFormatting(html: string, text: string): boolean {
  const normalized = normalizeEditorHtml(html).trim()
  if (!normalized) return false
  if (!FORMAT_TAGS.test(normalized)) {
    return plainTextFromHtml(normalized) !== text
  }
  // 只有 span 且没有实际样式 → 视为纯文本
  const stripped = normalized.replace(/<span(\s+[^>]*)?>/gi, (whole) => (/style=|class=/i.test(whole) ? whole : ''))
  return /<(b|strong|i|em|u|s|strike|del|a|code|font|mark)\b|style=/i.test(stripped)
}

/** 行内 HTML → Markdown（underline 无标准语法，保留 <u>） */
export function htmlToMarkdownInline(html: string): string {
  let s = normalizeEditorHtml(html)
  if (!s) return ''
  // 链接先处理（文字里可能含标签，交给内层递归）
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_w, href: string, inner: string) => {
    const label = inlineToPlain(inner)
    return label ? `[${label}](${decodeHtmlEntities(href)})` : label
  })
  s = s.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_w, _t, inner: string) => `**${htmlToMarkdownInline(inner)}**`)
  s = s.replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_w, _t, inner: string) => `*${htmlToMarkdownInline(inner)}*`)
  s = s.replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_w, _t, inner: string) => `~~${htmlToMarkdownInline(inner)}~~`)
  s = s.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, (_w, inner: string) => `<u>${htmlToMarkdownInline(inner)}</u>`)
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_w, inner: string) => `\`${inlineToPlain(inner)}\``)
  s = s.replace(/<span\b[^>]*>([\s\S]*?)<\/span>/gi, (_w, inner: string) => htmlToMarkdownInline(inner))
  s = s.replace(/<font\b[^>]*>([\s\S]*?)<\/font>/gi, (_w, inner: string) => htmlToMarkdownInline(inner))
  s = s.replace(/<br\s*\/?>/gi, ' ')
  s = s.replace(/<[^>]*>/g, '')
  return decodeHtmlEntities(s).replace(/​/g, '').replace(/\s+/g, ' ').trim()
}

function inlineToPlain(html: string): string {
  return decodeHtmlEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

/** 节点导出用：有富文本走 Markdown，否则原样纯文本 */
export function nodeMarkdownText(node: { text: string; html?: string }): string {
  if (node.html) {
    const md = htmlToMarkdownInline(node.html)
    if (md) return md
  }
  return node.text
}
