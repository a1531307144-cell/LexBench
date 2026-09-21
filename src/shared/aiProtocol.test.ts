import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_VERSION,
  authHeaders,
  buildBody,
  chatUrl,
  endpointHint,
  parseSseLine,
  pickReply,
  type ChatMessage
} from './aiProtocol'

const OPENAI = 'openai' as const
const ANTHROPIC = 'anthropic' as const

describe('chatUrl', () => {
  it('OpenAI：根地址补 /chat/completions', () => {
    expect(chatUrl(OPENAI, 'https://api.deepseek.com/v1')).toBe(
      'https://api.deepseek.com/v1/chat/completions'
    )
    expect(chatUrl(OPENAI, 'https://open.bigmodel.cn/api/paas/v4')).toBe(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions'
    )
  })

  it('OpenAI：尾斜杠与已写全的端点都不重复拼', () => {
    expect(chatUrl(OPENAI, 'https://api.deepseek.com/v1/')).toBe(
      'https://api.deepseek.com/v1/chat/completions'
    )
    expect(chatUrl(OPENAI, 'https://api.deepseek.com/v1/chat/completions')).toBe(
      'https://api.deepseek.com/v1/chat/completions'
    )
  })

  it('Anthropic：网关根地址补 /v1/messages', () => {
    expect(chatUrl(ANTHROPIC, 'https://open.bigmodel.cn/api/anthropic')).toBe(
      'https://open.bigmodel.cn/api/anthropic/v1/messages'
    )
  })

  it('Anthropic：写到 /v1 或 /messages 都不重复拼', () => {
    expect(chatUrl(ANTHROPIC, 'https://open.bigmodel.cn/api/anthropic/v1')).toBe(
      'https://open.bigmodel.cn/api/anthropic/v1/messages'
    )
    expect(chatUrl(ANTHROPIC, 'https://api.anthropic.com/v1/messages')).toBe(
      'https://api.anthropic.com/v1/messages'
    )
  })
})

describe('authHeaders', () => {
  it('OpenAI 走 Bearer', () => {
    const h = authHeaders(OPENAI, 'sk-abc')
    expect(h.Authorization).toBe('Bearer sk-abc')
    expect(h['Content-Type']).toBe('application/json')
    expect(h['x-api-key']).toBeUndefined()
  })

  it('Anthropic 走 x-api-key + 协议版本头；同时带 Bearer 以兼容只认它的网关', () => {
    const h = authHeaders(ANTHROPIC, 'sk-abc')
    expect(h['x-api-key']).toBe('sk-abc')
    expect(h['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(h.Authorization).toBe('Bearer sk-abc')
  })
})

describe('buildBody', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: '你是法律助手' },
    { role: 'user', content: '解释一下第一条' }
  ]

  it('OpenAI：messages 原样带 system，不含 max_tokens', () => {
    const body = buildBody(OPENAI, 'deepseek-chat', messages, true)
    expect(body.messages).toEqual(messages)
    expect(body.max_tokens).toBeUndefined()
    expect(body.stream).toBe(true)
    expect(body.system).toBeUndefined()
  })

  it('Anthropic：system 提到顶层，messages 里不再有 system 角色', () => {
    const body = buildBody(ANTHROPIC, 'glm-4.6', messages, false)
    expect(body.system).toBe('你是法律助手')
    expect(body.messages).toEqual([{ role: 'user', content: '解释一下第一条' }])
    expect(body.max_tokens).toBe(ANTHROPIC_MAX_TOKENS)
    expect(body.stream).toBe(false)
  })

  it('Anthropic：丢掉开头的 assistant（历史窗口从回答切起时不至于 400）', () => {
    const body = buildBody(
      ANTHROPIC,
      'glm-4.6',
      [
        { role: 'assistant', content: '上一轮的回答' },
        { role: 'user', content: '继续问' }
      ],
      false
    )
    expect(body.messages).toEqual([{ role: 'user', content: '继续问' }])
  })

  it('Anthropic：相邻同角色合并，保证严格交替', () => {
    const body = buildBody(
      ANTHROPIC,
      'glm-4.6',
      [
        { role: 'user', content: 'A' },
        { role: 'user', content: 'B' },
        { role: 'assistant', content: 'C' },
        { role: 'assistant', content: 'D' }
      ],
      false
    )
    expect(body.messages).toEqual([
      { role: 'user', content: 'A\n\nB' },
      { role: 'assistant', content: 'C\n\nD' }
    ])
  })

  it('Anthropic：整段只剩 assistant 时兜出一个合法 user 消息', () => {
    const body = buildBody(ANTHROPIC, 'glm-4.6', [{ role: 'assistant', content: '只有回答' }], false)
    expect(body.messages).toEqual([{ role: 'user', content: '只有回答' }])
  })

  it('Anthropic：多条 system 合并；无 system 时不发该字段', () => {
    const multi = buildBody(
      ANTHROPIC,
      'glm-4.6',
      [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'Q' }
      ],
      false
    )
    expect(multi.system).toBe('A\n\nB')
    const none = buildBody(ANTHROPIC, 'glm-4.6', [{ role: 'user', content: 'Q' }], false)
    expect('system' in none).toBe(false)
  })
})

describe('pickReply', () => {
  it('OpenAI：读 choices[0].message.content', () => {
    expect(pickReply(OPENAI, { choices: [{ message: { content: '你好' } }] })).toBe('你好')
    expect(pickReply(OPENAI, { choices: [] })).toBeNull()
    expect(pickReply(OPENAI, null)).toBeNull()
  })

  it('Anthropic：拼 content 里的 text 块，跳过 thinking 块', () => {
    const data = {
      content: [
        { type: 'thinking', thinking: '内心戏' },
        { type: 'text', text: '结论' },
        { type: 'text', text: '如下' }
      ]
    }
    expect(pickReply(ANTHROPIC, data)).toBe('结论如下')
  })

  it('Anthropic：没有 text 块时返回 null（交给调用方报格式异常）', () => {
    expect(pickReply(ANTHROPIC, { content: [{ type: 'thinking' }] })).toBeNull()
    expect(pickReply(ANTHROPIC, {})).toBeNull()
  })
})

describe('parseSseLine', () => {
  it('OpenAI：取 choices[0].delta.content，[DONE] 收尾', () => {
    expect(parseSseLine(OPENAI, 'data: {"choices":[{"delta":{"content":"你好"}}]}')).toEqual({
      kind: 'delta',
      text: '你好'
    })
    expect(parseSseLine(OPENAI, 'data: [DONE]')).toEqual({ kind: 'done' })
  })

  it('Anthropic：取 content_block_delta 的 delta.text，心跳与其它事件忽略', () => {
    expect(
      parseSseLine(ANTHROPIC, 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}')
    ).toEqual({ kind: 'delta', text: '你好' })
    expect(parseSseLine(ANTHROPIC, 'data: {"type":"message_start","message":{}}')).toEqual({ kind: 'skip' })
    expect(parseSseLine(ANTHROPIC, 'data: {"type":"message_stop"}')).toEqual({ kind: 'skip' })
    expect(parseSseLine(ANTHROPIC, 'data: {"type":"ping"}')).toEqual({ kind: 'skip' })
  })

  it('event: 行与空行一律忽略；非 data 行不误判', () => {
    expect(parseSseLine(ANTHROPIC, 'event: content_block_delta')).toEqual({ kind: 'skip' })
    expect(parseSseLine(OPENAI, '')).toEqual({ kind: 'skip' })
    expect(parseSseLine(OPENAI, ': keep-alive')).toEqual({ kind: 'skip' })
  })

  it('半截 / 非法 JSON 忽略而不打断整段回答', () => {
    expect(parseSseLine(OPENAI, 'data: {"choices":[{"delta":{')).toEqual({ kind: 'skip' })
  })

  it('流内错误两种协议都能抠出来', () => {
    expect(
      parseSseLine(ANTHROPIC, 'data: {"type":"error","error":{"type":"overloaded_error","message":"过载"}}')
    ).toEqual({ kind: 'error', message: '过载' })
    expect(parseSseLine(OPENAI, 'data: {"error":{"message":"额度不足"}}')).toEqual({
      kind: 'error',
      message: '额度不足'
    })
  })

  it('Anthropic 的 delta.text 为空串时不产出空增量', () => {
    expect(
      parseSseLine(
        ANTHROPIC,
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":""}}'
      )
    ).toEqual({ kind: 'skip' })
  })

  it('Anthropic：thinking_delta / input_json_delta 不算正文', () => {
    expect(
      parseSseLine(
        ANTHROPIC,
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"内心戏"}}'
      )
    ).toEqual({ kind: 'skip' })
    expect(
      parseSseLine(
        ANTHROPIC,
        'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}'
      )
    ).toEqual({ kind: 'skip' })
  })
})

describe('endpointHint', () => {
  it('按协议给出对应的正确样例', () => {
    expect(endpointHint(OPENAI)).toContain('/v1 或 /v4')
    expect(endpointHint(ANTHROPIC)).toContain('api/anthropic')
  })
})
