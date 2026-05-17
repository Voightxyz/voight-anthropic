/**
 * Tests for the async-context layer powering parent-span tracking,
 * route tagging, and log capture inside wrapped Anthropic calls.
 *
 * Mirrors the suite shipped in @voightxyz/openai's tests, adapted
 * to the messages-create instrument (no chat / completions namespace,
 * Anthropic-specific response shape).
 */

import { describe, it, expect, vi } from 'vitest'

import {
  drainTraceLogs,
  getCurrentTrace,
  pushSpanAndRun,
  withTrace,
} from '../../src/context.js'
import { log } from '../../src/log.js'
import { instrumentMessages } from '../../src/instruments/messages.js'
import type { EventPayload } from '../../src/types.js'

// ─── ctx + response factories ───────────────────────────────────

function makeContext(
  overrides: Partial<{ routeTag: string; sessionId: string }> = {},
) {
  const events: EventPayload[] = []
  const ingest = { send: (e: EventPayload) => void events.push(e) }
  let t = 1000
  return {
    events,
    ctx: {
      agentId: 'agent-x',
      privacy: 'full' as const,
      sessionId: overrides.sessionId ?? 'sess-test',
      routeTag: overrides.routeTag,
      ingest,
      now: () => {
        const v = t
        t += 250
        return v
      },
    },
  }
}

function nonStreamingResponse() {
  return {
    id: 'msg_test_ctx',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 5,
      output_tokens: 2,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  }
}

// ─── 1. Pure context helpers ─────────────────────────────────────

describe('withTrace / log / drain — outside a trace', () => {
  it('getCurrentTrace returns undefined when no trace is active', () => {
    expect(getCurrentTrace()).toBeUndefined()
  })

  it('log() is a no-op (and does not throw) outside withTrace', () => {
    expect(() => log('orphan line')).not.toThrow()
  })

  it('drainTraceLogs() returns an empty array outside withTrace', () => {
    expect(drainTraceLogs()).toEqual([])
  })

  it('pushSpanAndRun outside withTrace just runs the fn', async () => {
    const spy = vi.fn(async () => 'ok')
    const result = await pushSpanAndRun('span-1', spy)
    expect(result).toBe('ok')
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('withTrace — frame lifecycle', () => {
  it('opens a frame with an empty logs buffer + supplied routeTag', async () => {
    await withTrace(
      async () => {
        const trace = getCurrentTrace()
        expect(trace).toBeDefined()
        expect(trace!.logs).toEqual([])
        expect(trace!.routeTag).toBe('POST /api/chat')
        expect(trace!.currentSpanId).toBeUndefined()
      },
      { routeTag: 'POST /api/chat' },
    )
  })

  it('trims a routeTag with whitespace down to its content', async () => {
    await withTrace(
      async () => {
        expect(getCurrentTrace()!.routeTag).toBe('cron:nightly')
      },
      { routeTag: '   cron:nightly  ' },
    )
  })

  it('drops a blank routeTag to undefined (no "" leaking through)', async () => {
    await withTrace(
      async () => {
        expect(getCurrentTrace()!.routeTag).toBeUndefined()
      },
      { routeTag: '   ' },
    )
  })

  it('isolates frames across nested withTrace calls', async () => {
    await withTrace(async () => {
      log('outer line')
      await withTrace(async () => {
        const inner = getCurrentTrace()!
        expect(inner.logs).toEqual([])
        log('inner line')
        expect(inner.logs.map((l) => l.message)).toEqual(['inner line'])
      })
      expect(getCurrentTrace()!.logs.map((l) => l.message)).toEqual([
        'outer line',
      ])
    })
  })
})

describe('log() inside a trace', () => {
  it('appends to the active frame logs with default level "info"', async () => {
    await withTrace(async () => {
      log('something happened')
      const trace = getCurrentTrace()!
      expect(trace.logs).toHaveLength(1)
      expect(trace.logs[0]).toMatchObject({
        level: 'info',
        message: 'something happened',
      })
      expect(typeof trace.logs[0]!.ts).toBe('string')
    })
  })

  it('respects an explicit level option', async () => {
    await withTrace(async () => {
      log('boom', { level: 'error' })
      log('be careful', { level: 'warn' })
      const levels = getCurrentTrace()!.logs.map((l) => l.level)
      expect(levels).toEqual(['error', 'warn'])
    })
  })

  it('preserves insertion order across multiple calls', async () => {
    await withTrace(async () => {
      log('a')
      log('b')
      log('c')
      expect(getCurrentTrace()!.logs.map((l) => l.message)).toEqual([
        'a',
        'b',
        'c',
      ])
    })
  })
})

describe('drainTraceLogs — drains the buffer', () => {
  it('returns the current logs and clears the frame buffer', async () => {
    await withTrace(async () => {
      log('one')
      log('two')
      const drained = drainTraceLogs()
      expect(drained.map((l) => l.message)).toEqual(['one', 'two'])
      expect(getCurrentTrace()!.logs).toEqual([])
    })
  })

  it('returns an empty array when there is nothing to drain', async () => {
    await withTrace(async () => {
      expect(drainTraceLogs()).toEqual([])
    })
  })
})

describe('pushSpanAndRun — currentSpanId stack', () => {
  it('sets currentSpanId for the duration of fn and restores it after', async () => {
    await withTrace(async () => {
      expect(getCurrentTrace()!.currentSpanId).toBeUndefined()
      await pushSpanAndRun('span-a', async () => {
        expect(getCurrentTrace()!.currentSpanId).toBe('span-a')
      })
      expect(getCurrentTrace()!.currentSpanId).toBeUndefined()
    })
  })

  it('nests cleanly: inner restores outer, outer restores undefined', async () => {
    await withTrace(async () => {
      await pushSpanAndRun('outer', async () => {
        expect(getCurrentTrace()!.currentSpanId).toBe('outer')
        await pushSpanAndRun('inner', async () => {
          expect(getCurrentTrace()!.currentSpanId).toBe('inner')
        })
        expect(getCurrentTrace()!.currentSpanId).toBe('outer')
      })
      expect(getCurrentTrace()!.currentSpanId).toBeUndefined()
    })
  })

  it('restores currentSpanId even when fn throws', async () => {
    await withTrace(async () => {
      await expect(
        pushSpanAndRun('span-throws', async () => {
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      expect(getCurrentTrace()!.currentSpanId).toBeUndefined()
    })
  })
})

// ─── 2. Integration with the messages instrument ────────────────

describe('messages × context', () => {
  it('stamps metadata.spanId on every event, even outside withTrace', async () => {
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
    expect(events).toHaveLength(1)
    const meta = events[0]!.metadata as Record<string, unknown>
    expect(typeof meta.spanId).toBe('string')
    expect((meta.spanId as string).length).toBeGreaterThan(0)
    expect(meta.parentSpanId).toBeUndefined()
    expect(meta.endpoint).toBeUndefined()
    expect(meta.logs).toBeUndefined()
  })

  it('emits metadata.endpoint from ctx.routeTag when there is no trace', async () => {
    const { ctx, events } = makeContext({ routeTag: 'cron:rollup' })
    const wrapped = instrumentMessages(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await wrapped({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    expect((events[0]!.metadata as Record<string, unknown>).endpoint).toBe(
      'cron:rollup',
    )
  })

  it('lets a withTrace routeTag override the wrapper-level routeTag', async () => {
    const { ctx, events } = makeContext({ routeTag: 'default-tag' })
    const wrapped = instrumentMessages(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await withTrace(
      async () => {
        await wrapped({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
        } as never)
      },
      { routeTag: 'POST /api/chat' },
    )
    expect((events[0]!.metadata as Record<string, unknown>).endpoint).toBe(
      'POST /api/chat',
    )
  })

  it('drains accumulated log() lines into metadata.logs on the next event', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentMessages(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await withTrace(async () => {
      log('preparing call')
      log('cache miss', { level: 'warn' })
      await wrapped({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      } as never)
    })
    const meta = events[0]!.metadata as Record<string, unknown>
    const logs = meta.logs as Array<{ level: string; message: string }>
    expect(logs).toBeDefined()
    expect(logs.map((l) => ({ level: l.level, message: l.message }))).toEqual([
      { level: 'info', message: 'preparing call' },
      { level: 'warn', message: 'cache miss' },
    ])
  })

  it('clears the log buffer after a call so the next event gets only fresh lines', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentMessages(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await withTrace(async () => {
      log('first batch line')
      await wrapped({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      } as never)
      log('second batch line')
      await wrapped({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      } as never)
    })
    const meta1 = events[0]!.metadata as Record<string, unknown>
    const meta2 = events[1]!.metadata as Record<string, unknown>
    expect((meta1.logs as Array<{ message: string }>).map((l) => l.message)).toEqual([
      'first batch line',
    ])
    expect((meta2.logs as Array<{ message: string }>).map((l) => l.message)).toEqual([
      'second batch line',
    ])
  })

  it('sets parentSpanId on nested wrapped calls to the outer call\'s spanId', async () => {
    const { ctx, events } = makeContext()
    let outerSpanId: string | undefined
    const innerWrapped = instrumentMessages(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    const outerWrapped = instrumentMessages(
      (async () => {
        outerSpanId = getCurrentTrace()?.currentSpanId
        await innerWrapped({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'nested' }],
        } as never)
        return nonStreamingResponse()
      }) as never,
      ctx,
    )

    await withTrace(async () => {
      await outerWrapped({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'outer' }],
      } as never)
    })

    expect(events).toHaveLength(2)
    const innerMeta = events[0]!.metadata as Record<string, unknown>
    const outerMeta = events[1]!.metadata as Record<string, unknown>
    expect(innerMeta.parentSpanId).toBe(outerSpanId)
    expect(outerMeta.parentSpanId).toBeUndefined()
  })
})
