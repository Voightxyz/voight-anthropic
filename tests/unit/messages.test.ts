/**
 * Tests for the messages instrument.
 *
 * Strategy mirrors @voightxyz/openai's chat-completions tests:
 *   - The Anthropic SDK is treated as an opaque function: we hand
 *     the instrument a fake `original` that returns a canned response
 *     (or async iterator), and assert what events land in a captured
 *     ingest sink.
 *   - Anthropic's shape differs from OpenAI's in three places that
 *     this suite is explicit about:
 *       · `content` is an array of typed blocks (text, tool_use, …)
 *       · streaming is an event sequence (message_start, content_
 *         block_delta, message_delta, …) not a flat chunk iterator
 *       · `usage` reports `cache_read_input_tokens` and
 *         `cache_creation_input_tokens` separately (the OpenAI port
 *         only sees a single `cached_tokens` field)
 */

import { describe, it, expect, vi } from 'vitest'

import { instrumentMessages } from '../../src/instruments/messages.js'
import type { EventPayload } from '../../src/types.js'

function makeContext(
  overrides: Partial<{
    privacy: 'minimal' | 'standard' | 'full'
    agentId: string
    now: () => number
  }> = {},
) {
  const events: EventPayload[] = []
  const ingest = { send: (e: EventPayload) => void events.push(e) }
  const times = [1000, 1250]
  const ctx = {
    agentId: overrides.agentId ?? 'test-agent',
    privacy: overrides.privacy ?? ('full' as const),
    ingest,
    now: overrides.now ?? (() => times.shift() ?? 0),
  }
  return { ctx, events }
}

function nonStreamingResponse(
  extra: Partial<Record<string, unknown>> = {},
) {
  return {
    id: 'msg_test_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: 'hello back' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
    ...extra,
  }
}

describe('instrumentMessages — non-streaming', () => {
  it('passes the original response through to the caller', async () => {
    const { ctx } = makeContext()
    const original = vi.fn(async () => nonStreamingResponse())
    const wrapped = instrumentMessages(original as never, ctx)

    const result = await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)

    expect(result).toEqual(nonStreamingResponse())
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('emits one event with agentId, model, durationMs, outcome=success', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentMessages(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )

    await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.agentId).toBe('test-agent')
    expect(e.model).toBe('claude-3-5-sonnet-20241022')
    expect(e.durationMs).toBe(250)
    expect(e.outcome).toBe('success')
    expect(e.type).toBe('reasoning')
    expect(e.metadata?.source).toBe('anthropic-sdk')
  })

  it('captures plain token counts under metadata.tokens', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentMessages(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )

    await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.tokens).toEqual({
      input: 12,
      output: 5,
      total: 17,
    })
  })

  it('emits cache_read when cache_read_input_tokens > 0', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentMessages(
      (async () =>
        nonStreamingResponse({
          usage: {
            input_tokens: 1500,
            output_tokens: 200,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: 1024,
          },
        })) as never,
      ctx,
    )

    await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'long prompt' }],
    } as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.tokens).toEqual({
      input: 1500,
      output: 200,
      total: 1700,
      cache_read: 1024,
    })
  })

  it('emits cache_creation when cache_creation_input_tokens > 0', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentMessages(
      (async () =>
        nonStreamingResponse({
          usage: {
            input_tokens: 2000,
            output_tokens: 100,
            cache_creation_input_tokens: 1500,
            cache_read_input_tokens: null,
          },
        })) as never,
      ctx,
    )

    await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'prompt' }],
    } as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.tokens).toEqual({
      input: 2000,
      output: 100,
      total: 2100,
      cache_creation: 1500,
    })
  })

  it('omits cache fields when both null / zero', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentMessages(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )

    await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    await new Promise((r) => setTimeout(r, 0))

    const tokens = events[0]!.metadata?.tokens as Record<string, unknown>
    expect(tokens).not.toHaveProperty('cache_read')
    expect(tokens).not.toHaveProperty('cache_creation')
  })

  it('extracts response text from content[].text blocks', async () => {
    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentMessages(
      (async () =>
        nonStreamingResponse({
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
          ],
        })) as never,
      ctx,
    )

    await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'say hi' }],
    } as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.responseText).toBe('Hello world')
  })

  it('captures tool_use blocks into metadata.toolCalls and toolExecuted', async () => {
    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentMessages(
      (async () =>
        nonStreamingResponse({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_abc',
              name: 'get_weather',
              input: { location: 'Tokyo' },
            },
          ],
          stop_reason: 'tool_use',
        })) as never,
      ctx,
    )

    await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'weather in Tokyo?' }],
    } as never)
    await new Promise((r) => setTimeout(r, 0))

    const e = events[0]!
    expect(e.toolExecuted).toBe('get_weather')
    expect(e.metadata?.toolCalls).toEqual([
      {
        id: 'toolu_abc',
        name: 'get_weather',
        arguments: '{"location":"Tokyo"}',
      },
    ])
  })

  it('captures stop_reason on metadata.finishReason', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentMessages(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(events[0]!.metadata?.finishReason).toBe('end_turn')
  })

  it('drops messages + responseText + toolCalls under privacy=minimal but keeps toolExecuted', async () => {
    const { ctx, events } = makeContext({ privacy: 'minimal' })
    const wrapped = instrumentMessages(
      (async () =>
        nonStreamingResponse({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_x',
              name: 'send_email',
              input: { to: 'user@example.com' },
            },
          ],
        })) as never,
      ctx,
    )

    await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'send email' }],
    } as never)
    await new Promise((r) => setTimeout(r, 0))

    const e = events[0]!
    expect(e.input).toBeUndefined()
    expect(e.metadata?.responseText).toBeUndefined()
    expect(e.metadata?.toolCalls).toBeUndefined()
    expect(e.toolExecuted).toBe('send_email')
    expect(e.metadata?.tokens).toBeDefined()
  })

  it('scrubs PII inside messages, response text, and tool args under privacy=standard', async () => {
    const { ctx, events } = makeContext({ privacy: 'standard' })
    const wrapped = instrumentMessages(
      (async () =>
        nonStreamingResponse({
          content: [
            { type: 'text', text: 'reply to jane@acme.io' },
            {
              type: 'tool_use',
              id: 'toolu_x',
              name: 'send_email',
              input: { to: 'support@example.com' },
            },
          ],
        })) as never,
      ctx,
    )

    await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'mail me at user@example.com' }],
    } as never)
    await new Promise((r) => setTimeout(r, 0))

    const e = events[0]!
    expect((e.input!.messages as { content: string }[])[0]!.content).toBe(
      'mail me at [REDACTED-EMAIL]',
    )
    expect(e.metadata?.responseText).toBe('reply to [REDACTED-EMAIL]')
    const toolCalls = e.metadata?.toolCalls as Array<{ arguments: string }>
    expect(toolCalls[0]!.arguments).toContain('[REDACTED-EMAIL]')
  })

  it('records outcome=failed + errorMessage when original throws, then re-throws', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentMessages(
      (async () => {
        throw new Error('rate_limit_exceeded')
      }) as never,
      ctx,
    )

    await expect(
      wrapped({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      } as never),
    ).rejects.toThrow('rate_limit_exceeded')

    await new Promise((r) => setTimeout(r, 0))
    expect(events).toHaveLength(1)
    expect(events[0]!.outcome).toBe('failed')
    expect(events[0]!.errorMessage).toBe('rate_limit_exceeded')
  })
})

describe('instrumentMessages — streaming', () => {
  async function* mockTextStream() {
    yield {
      type: 'message_start',
      message: {
        id: 'msg_s1',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
    }
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hel' },
    }
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'lo' },
    }
    yield { type: 'content_block_stop', index: 0 }
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    }
    yield { type: 'message_stop' }
  }

  it('passes every event to the caller in order, unchanged', async () => {
    const { ctx } = makeContext()
    const wrapped = instrumentMessages(
      (async () => mockTextStream()) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) as AsyncIterable<{ type: string }>

    const types: string[] = []
    for await (const ev of stream) types.push(ev.type)

    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  it('emits a single event with aggregated text + final tokens', async () => {
    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentMessages(
      (async () => mockTextStream()) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) as AsyncIterable<unknown>
    for await (const _ of stream) void _

    await new Promise((r) => setTimeout(r, 0))
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.model).toBe('claude-3-5-sonnet-20241022')
    expect(e.metadata?.responseText).toBe('hello')
    expect(e.metadata?.streaming).toBe(true)
    expect(e.metadata?.tokens).toEqual({
      input: 10,
      output: 2,
      total: 12,
    })
    expect(e.metadata?.finishReason).toBe('end_turn')
  })

  it('aggregates streaming tool_use deltas into a single toolCalls entry', async () => {
    async function* mockToolStream() {
      yield {
        type: 'message_start',
        message: {
          id: 'msg_t1',
          model: 'claude-3-5-sonnet-20241022',
          usage: {
            input_tokens: 50,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      }
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_stream',
          name: 'get_weather',
          input: {},
        },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"loc' },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'ation":"Tokyo"}' },
      }
      yield { type: 'content_block_stop', index: 0 }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 20 },
      }
      yield { type: 'message_stop' }
    }

    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentMessages(
      (async () => mockToolStream()) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'weather?' }],
    } as never)) as AsyncIterable<unknown>
    for await (const _ of stream) void _

    await new Promise((r) => setTimeout(r, 0))
    expect(events[0]!.toolExecuted).toBe('get_weather')
    expect(events[0]!.metadata?.toolCalls).toEqual([
      {
        id: 'toolu_stream',
        name: 'get_weather',
        arguments: '{"location":"Tokyo"}',
      },
    ])
  })

  it('captures cache_read from message_start when present in streaming', async () => {
    async function* mockCacheStream() {
      yield {
        type: 'message_start',
        message: {
          id: 'msg_c1',
          model: 'claude-3-5-sonnet-20241022',
          usage: {
            input_tokens: 1500,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: 1024,
          },
        },
      }
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      }
      yield { type: 'content_block_stop', index: 0 }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 200 },
      }
      yield { type: 'message_stop' }
    }

    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentMessages(
      (async () => mockCacheStream()) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'long prompt' }],
    } as never)) as AsyncIterable<unknown>
    for await (const _ of stream) void _

    await new Promise((r) => setTimeout(r, 0))
    expect(events[0]!.metadata?.tokens).toEqual({
      input: 1500,
      output: 200,
      total: 1700,
      cache_read: 1024,
    })
  })
})
