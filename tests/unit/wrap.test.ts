/**
 * Tests for `wrapAnthropic` — the package's public entrypoint.
 *
 * Mirrors the @voightxyz/openai wrap suite. The wrapper composes
 * identity + ingest + the messages instrument behind a Proxy of
 * two layers (client → messages → create). Network capture is
 * exercised via a `fetch` injection so unit tests don't need a
 * real Voight backend.
 */

import { describe, it, expect, vi } from 'vitest'

import { wrapAnthropic } from '../../src/wrap.js'

function fakeAnthropicClient(handlers: {
  create?: (params: unknown) => Promise<unknown>
  otherMethod?: () => string
} = {}) {
  return {
    messages: {
      create:
        handlers.create ??
        (async () => ({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-3-5-sonnet-20241022',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        })),
    },
    models: {
      list: handlers.otherMethod ?? (() => 'unrelated-passthrough'),
    },
  }
}

describe('wrapAnthropic', () => {
  it('forwards messages.create through to the original', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))
    const original = vi.fn(async () => ({
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet-20241022',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    }))

    const client = wrapAnthropic(fakeAnthropicClient({ create: original }), {
      voightApiKey: 'vk_test',
      agent: 'test-agent',
      privacy: 'full',
      apiBase: 'https://api.example.test',
      _fetch: fetchMock,
    } as never)

    const result = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(original).toHaveBeenCalledOnce()
    expect((result as { id: string }).id).toBe('msg_2')
  })

  it('emits a network event after a messages.create call', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))

    const client = wrapAnthropic(fakeAnthropicClient(), {
      voightApiKey: 'vk_test',
      agent: 'test-agent',
      privacy: 'minimal',
      apiBase: 'https://api.example.test',
      _fetch: fetchMock,
    } as never)

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(fetchMock).toHaveBeenCalledOnce()
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer vk_test',
    )
    const body = JSON.parse(init.body as string)
    expect(body.agentId).toBe('test-agent')
    expect(body.type).toBe('reasoning')
    expect(body.model).toBe('claude-3-5-sonnet-20241022')
    expect(body.metadata.source).toBe('anthropic-sdk')
  })

  it('passes unrelated client properties through untouched', () => {
    const otherMethod = vi.fn(() => 'unrelated-passthrough')
    const client = wrapAnthropic(fakeAnthropicClient({ otherMethod }), {
      voightApiKey: 'vk_test',
      agent: 'test-agent',
    } as never)

    expect(client.models.list()).toBe('unrelated-passthrough')
    expect(otherMethod).toHaveBeenCalledOnce()
  })

  it('returns the original client untouched when enabled=false', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))
    const original = vi.fn(async () => ({
      id: 'noop',
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }))

    const client = wrapAnthropic(fakeAnthropicClient({ create: original }), {
      voightApiKey: 'vk_test',
      agent: 'test-agent',
      enabled: false,
      _fetch: fetchMock,
    } as never)

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(original).toHaveBeenCalledOnce()
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is a no-op transport when no API key resolves (with a warn)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const client = wrapAnthropic(fakeAnthropicClient(), {
      agent: 'test-agent',
      _fetch: fetchMock,
      _env: {},
    } as never)

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
