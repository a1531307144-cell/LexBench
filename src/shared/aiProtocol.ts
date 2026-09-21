// 接口协议适配层（纯函数，无 Electron / fetch 依赖，供主进程与单测共用）
//
// 两套协议的区别都收敛在这里：
//   openai    —— POST {base}/chat/completions，Bearer 鉴权，messages 里带 system，
//                流式增量在 choices[0].delta.content，以 [DONE] 收尾
//   anthropic —— POST {base}/v1/messages，x-api-key + anthropic-version 鉴权，
//                system 提到顶层且 max_tokens 必填，
//                流式增量在 content_block_delta 的 delta.text，以 message_stop 收尾

import type { AiProtocol } from './types'

/** 单条对话消息（统一含 system；Anthropic 侧由 buildBody 把 system 提到顶层） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Anthropic 的 max_tokens 是必填项：给一个够长的默认值（解读法条 / 找案例用） */
export const ANTHROPIC_MAX_TOKENS = 4096

/** Anthropic 要求的协议版本头 */
export const ANTHROPIC_VERSION = '2023-06-01'

/** 温度：与改动前保持一致的 0.3（法律场景求稳） */
const TEMPERATURE = 0.3

/**
 * 请求地址。用户填的地址宽容处理：
 *   - 已经写到端点（…/messages、…/chat/completions）就原样用
 *   - 只写到 …/v1 就补端点
 *   - 只写到网关根（…/api/anthropic、…/api/paas/v4、…/v1）就补协议默认路径
 */
export function chatUrl(protocol: AiProtocol, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (protocol === 'anthropic') {
    if (/\/messages$/i.test(base)) return base
    // 智谱的 Anthropic 端点是 …/api/anthropic（不含 /v1），故只在用户已写到 /v1 时才不补
    return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`
  }
  if (/\/chat\/completions$/i.test(base)) return base
  return `${base}/chat/completions`
}

/**
 * 请求头（密钥不进日志、不进错误文案）。
 * Anthropic 官方要求 x-api-key + anthropic-version；但兼容网关各家不一——智谱等有的只认
 * Authorization: Bearer（那是它们 OpenAI 侧的惯例）。两个都发：官方忽略多余的 Authorization，
 * 网关则总有一个能命中，省得用户对着 401 猜是哪种鉴权。
 */
export function authHeaders(protocol: AiProtocol, apiKey: string): Record<string, string> {
  const common = { 'Content-Type': 'application/json' }
  return protocol === 'anthropic'
    ? {
        ...common,
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        Authorization: `Bearer ${apiKey}`
      }
    : { ...common, Authorization: `Bearer ${apiKey}` }
}

/**
 * Anthropic 对 messages 有硬性要求：非空、首条必须是 user、user/assistant 严格交替。
 * 「追问」的历史是按条数截窗口的，一旦从某轮的回答切起就会以 assistant 开头，服务端直接 400；
 * 相邻同角色（历史里若出现）同样违规。这里统一兜住，让上层不必关心这些约束。
 */
function normalizeAnthropicMessages(
  messages: ChatMessage[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}` // 相邻同角色 → 合并，避免「不交替」
      continue
    }
    out.push({ role: m.role, content: m.content })
  }
  while (out.length > 0 && out[0].role === 'assistant') out.shift() // 首条不能是 assistant
  if (out.length === 0) {
    // 兜底：整段只剩 assistant（或本就为空）时，至少给出一个合法的 user 消息，
    // 否则用户只会看到一个没头没尾的 400
    const last = messages[messages.length - 1]
    if (last) out.push({ role: 'user', content: last.content })
  }
  return out
}

/**
 * 请求体。Anthropic 要求：
 *   - system 是顶层字段，不能出现在 messages 的 role 里
 *   - max_tokens 必填（漏掉会直接 400）
 */
export function buildBody(
  protocol: AiProtocol,
  model: string,
  messages: ChatMessage[],
  stream: boolean
): Record<string, unknown> {
  if (protocol !== 'anthropic') {
    return { model, messages, temperature: TEMPERATURE, stream }
  }
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const rest = normalizeAnthropicMessages(messages)
  return {
    model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    ...(system ? { system } : {}),
    messages: rest,
    temperature: TEMPERATURE,
    stream
  }
}

/** 非流式响应取文；结构不符返回 null（不抛，交给调用方给中文提示） */
export function pickReply(protocol: AiProtocol, data: unknown): string | null {
  if (protocol === 'anthropic') {
    const content = (data as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) return null
    // 只收 text 块；thinking 等非文本块跳过
    const text = content
      .filter((b): b is { type?: unknown; text?: unknown } => !!b && typeof b === 'object')
      .filter((b) => b.type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('')
    return text ? text : null
  }
  const choices = (data as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices
  const reply = choices?.[0]?.message?.content
  return typeof reply === 'string' ? reply : null
}

/** 一行 SSE 的解析结果：增量文本 / 结束 / 流内错误 / 忽略 */
export type SseLine =
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'skip' }

/** 从流式帧里抠出错误信息：Anthropic 的 {"type":"error","error":{…}} 与 OpenAI 式的 {"error":{…}} */
function sseErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const err = (data as { error?: unknown }).error
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg) return msg
    return '未知错误'
  }
  return null
}

/**
 * 解析一行 SSE。
 * 只有 'data:' 开头的行是数据（'event:' 行与空行自然跳过）；
 * '[DONE]' 是 OpenAI 的结束标记，Anthropic 的结束靠 message_stop（无增量，按 skip 处理，
 * 由流自然结束收尾）。
 */
export function parseSseLine(protocol: AiProtocol, line: string): SseLine {
  if (!line.startsWith('data:')) return { kind: 'skip' }
  const payload = line.slice('data:'.length).trim()
  if (!payload) return { kind: 'skip' }
  if (payload === '[DONE]') return { kind: 'done' }
  let data: unknown
  try {
    data = JSON.parse(payload)
  } catch {
    return { kind: 'skip' } // 半截/非标准行一律忽略，不打断整段回答
  }
  const failure = sseErrorMessage(data)
  if (failure) return { kind: 'error', message: failure }

  if (protocol === 'anthropic') {
    const d = data as { type?: unknown; delta?: { type?: unknown; text?: unknown } }
    if (d.type !== 'content_block_delta') return { kind: 'skip' }
    // delta.text 只在 text_delta 下是正文：thinking_delta 放的是 thinking、
    // input_json_delta 放的是 partial_json，别混进来
    if (d.delta?.type !== 'text_delta') return { kind: 'skip' }
    const text = d.delta.text
    return typeof text === 'string' && text ? { kind: 'delta', text } : { kind: 'skip' }
  }
  const text = (data as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]?.delta
    ?.content
  return typeof text === 'string' && text ? { kind: 'delta', text } : { kind: 'skip' }
}

/** 端点填错时的提示尾巴（「200 + 错误体」时贴给用户看，按当前协议给出正确样例） */
export function endpointHint(protocol: AiProtocol): string {
  return protocol === 'anthropic'
    ? '接口地址可能不是 Anthropic 兼容端点——应填网关的 Anthropic 入口（如 https://open.bigmodel.cn/api/anthropic）'
    : '接口地址可能不是 OpenAI 兼容端点——应以 /v1 或 /v4 结尾，例如 https://open.bigmodel.cn/api/paas/v4'
}
