/**
 * Tests for the OpenTelemetry side-channel of `@voightxyz/anthropic`.
 *
 * Mirror of the suite in `@voightxyz/openai` — same coverage shape,
 * different system/package/model fixtures. The shared invariants are
 * intentional: the two wrappers must produce structurally identical
 * span attribute bags (modulo `gen_ai.system`) so a downstream OTel
 * consumer can treat them uniformly.
 */

import { describe, it, expect } from 'vitest'

import {
  attributesForEvent,
  createEmitter,
  type OtelLikeModule,
  type OtelLikeSpan,
  type OtelLikeTracer,
} from '../../src/otel-emit'
import type { EventPayload } from '../../src/types'

// ─── Fake OTel module ───────────────────────────────────────────────

interface RecordedSpan {
  name: string
  startTime: number | undefined
  attributes: Record<string, string | number | boolean>
  statusCode: number | null
  statusMessage: string | null
  ended: boolean
  endedAt: number | null
  exceptions: unknown[]
}

function makeFakeOtel(): {
  mod: OtelLikeModule
  spans: RecordedSpan[]
  throwOnStartSpan: (err: Error) => void
} {
  const spans: RecordedSpan[] = []
  let injectedThrow: Error | null = null

  const SpanStatusCode = { OK: 1, ERROR: 2, UNSET: 0 } as const

  const tracer: OtelLikeTracer = {
    startSpan(name, options) {
      if (injectedThrow !== null) {
        const err = injectedThrow
        injectedThrow = null
        throw err
      }
      const record: RecordedSpan = {
        name,
        startTime: options?.startTime,
        attributes: { ...(options?.attributes ?? {}) } as Record<
          string,
          string | number | boolean
        >,
        statusCode: null,
        statusMessage: null,
        ended: false,
        endedAt: null,
        exceptions: [],
      }
      const span: OtelLikeSpan = {
        setAttributes(attrs) {
          Object.assign(record.attributes, attrs)
        },
        setStatus(status) {
          record.statusCode = status.code
          record.statusMessage = status.message ?? null
        },
        recordException(err) {
          record.exceptions.push(err)
        },
        end(endTime) {
          record.ended = true
          record.endedAt = endTime ?? null
        },
      }
      spans.push(record)
      return span
    },
  }

  return {
    mod: {
      trace: { getTracer: () => tracer },
      SpanStatusCode,
    },
    spans,
    throwOnStartSpan: (err) => {
      injectedThrow = err
    },
  }
}

// ─── Event fixtures ─────────────────────────────────────────────────

function baseEvent(overrides: Partial<EventPayload> = {}): EventPayload {
  return {
    agentId: 'agt_smoke',
    type: 'reasoning',
    model: 'claude-haiku-4-5',
    durationMs: 1234,
    outcome: 'success',
    metadata: {
      sessionId: '11111111-2222-3333-4444-555555555555',
      tokens: { input: 100, output: 50 },
      finishReason: 'end_turn',
    },
    ...overrides,
  }
}

// ─── attributesForEvent — pure ──────────────────────────────────────

describe('attributesForEvent', () => {
  it('maps the @voightxyz/anthropic package to gen_ai.system=anthropic', () => {
    const attrs = attributesForEvent(baseEvent(), '@voightxyz/anthropic')
    expect(attrs['gen_ai.system']).toBe('anthropic')
    expect(attrs['ai.model.provider']).toBe('anthropic')
  })

  it('maps the @voightxyz/openai package to gen_ai.system=openai', () => {
    const attrs = attributesForEvent(baseEvent(), '@voightxyz/openai')
    expect(attrs['gen_ai.system']).toBe('openai')
    expect(attrs['ai.model.provider']).toBe('openai')
  })

  it('preserves the model id verbatim for downstream cost lookups', () => {
    const attrs = attributesForEvent(
      baseEvent({ model: 'claude-opus-4-7-20250101' }),
      '@voightxyz/anthropic',
    )
    expect(attrs['gen_ai.request.model']).toBe('claude-opus-4-7-20250101')
    expect(attrs['ai.model.id']).toBe('claude-opus-4-7-20250101')
  })

  it('emits input/output token counts under both gen_ai and ai namespaces', () => {
    const attrs = attributesForEvent(
      baseEvent({
        metadata: { tokens: { input: 100, output: 50 } },
      }),
      '@voightxyz/anthropic',
    )
    expect(attrs['gen_ai.usage.input_tokens']).toBe(100)
    expect(attrs['gen_ai.usage.output_tokens']).toBe(50)
    expect(attrs['ai.usage.promptTokens']).toBe(100)
    expect(attrs['ai.usage.completionTokens']).toBe(50)
  })

  it('emits cache_read tokens when present (and only when present)', () => {
    const withCache = attributesForEvent(
      baseEvent({
        metadata: {
          tokens: { input: 100, output: 50, cache_read: 80 },
        },
      }),
      '@voightxyz/anthropic',
    )
    expect(withCache['gen_ai.usage.cache_read_input_tokens']).toBe(80)
    expect(withCache['ai.usage.cachedInputTokens']).toBe(80)

    const withoutCache = attributesForEvent(
      baseEvent(),
      '@voightxyz/anthropic',
    )
    expect(
      'gen_ai.usage.cache_read_input_tokens' in withoutCache,
    ).toBe(false)
    expect('ai.usage.cachedInputTokens' in withoutCache).toBe(false)
  })

  it('serialises finish reason as a JSON array on gen_ai (semconv) and a scalar on ai (Vercel)', () => {
    const attrs = attributesForEvent(
      baseEvent({ metadata: { finishReason: 'tool_use' } }),
      '@voightxyz/anthropic',
    )
    expect(attrs['gen_ai.response.finish_reasons']).toBe('["tool_use"]')
    expect(attrs['ai.response.finishReason']).toBe('tool_use')
  })

  it("stamps voight.source='wrapper' so the Voight exporter can dedupe", () => {
    const attrs = attributesForEvent(baseEvent(), '@voightxyz/anthropic')
    expect(attrs['voight.source']).toBe('wrapper')
    expect(attrs['voight.package']).toBe('@voightxyz/anthropic')
  })

  it('forwards agent + sessionId + endpoint + api + streaming markers', () => {
    const attrs = attributesForEvent(
      baseEvent({
        agentId: 'production-chat-api',
        metadata: {
          sessionId: 'sess-abc',
          endpoint: 'POST /api/chat',
          api: 'messages',
          streaming: true,
        },
      }),
      '@voightxyz/anthropic',
    )
    expect(attrs['voight.agent']).toBe('production-chat-api')
    expect(attrs['voight.sessionId']).toBe('sess-abc')
    expect(attrs['voight.endpoint']).toBe('POST /api/chat')
    expect(attrs['voight.api']).toBe('messages')
    expect(attrs['voight.streaming']).toBe(true)
  })

  it('omits voight.* markers when their source values are missing', () => {
    const attrs = attributesForEvent(
      { type: 'reasoning', outcome: 'success' } as EventPayload,
      '@voightxyz/anthropic',
    )
    expect('voight.agent' in attrs).toBe(false)
    expect('voight.sessionId' in attrs).toBe(false)
    expect('voight.endpoint' in attrs).toBe(false)
    expect('voight.api' in attrs).toBe(false)
    expect(attrs['voight.source']).toBe('wrapper')
    expect(attrs['voight.package']).toBe('@voightxyz/anthropic')
  })

  it('silently drops non-numeric token values instead of forwarding NaN', () => {
    const attrs = attributesForEvent(
      baseEvent({
        metadata: {
          tokens: {
            input: 'lots' as unknown as number,
            output: 50,
          },
        },
      }),
      '@voightxyz/anthropic',
    )
    expect('gen_ai.usage.input_tokens' in attrs).toBe(false)
    expect('ai.usage.promptTokens' in attrs).toBe(false)
    expect(attrs['gen_ai.usage.output_tokens']).toBe(50)
  })
})

// ─── createEmitter — wiring ─────────────────────────────────────────

describe('createEmitter', () => {
  it("returns null when the OTel module isn't loadable (graceful degradation)", () => {
    let observedError: unknown = null
    const emitter = createEmitter({
      packageName: '@voightxyz/anthropic',
      packageVersion: '0.1.8',
      otelModule: {
        trace: {
          getTracer() {
            throw new Error('synthetic tracer-creation failure')
          },
        },
        SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
      },
      onLoadError: (err) => {
        observedError = err
      },
    })
    expect(emitter).toBeNull()
    expect((observedError as Error)?.message).toBe(
      'synthetic tracer-creation failure',
    )
  })

  it("emits one span per call named 'voight.anthropic.messages' with the expected attribute set", () => {
    const { mod, spans } = makeFakeOtel()
    const emitter = createEmitter({
      packageName: '@voightxyz/anthropic',
      packageVersion: '0.1.8',
      otelModule: mod,
    })
    expect(emitter).not.toBeNull()
    emitter!.emit(baseEvent())
    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.name).toBe('voight.anthropic.messages')
    expect(span.attributes['gen_ai.system']).toBe('anthropic')
    expect(span.attributes['gen_ai.request.model']).toBe('claude-haiku-4-5')
    expect(span.attributes['voight.source']).toBe('wrapper')
    expect(span.ended).toBe(true)
  })

  it('sets span.status=OK on a successful event', () => {
    const { mod, spans } = makeFakeOtel()
    const emitter = createEmitter({
      packageName: '@voightxyz/anthropic',
      packageVersion: '0.1.8',
      otelModule: mod,
    })
    emitter!.emit(baseEvent({ outcome: 'success' }))
    expect(spans[0]!.statusCode).toBe(1)
  })

  it('sets span.status=ERROR and forwards the error message on a failed event', () => {
    const { mod, spans } = makeFakeOtel()
    const emitter = createEmitter({
      packageName: '@voightxyz/anthropic',
      packageVersion: '0.1.8',
      otelModule: mod,
    })
    emitter!.emit(
      baseEvent({ outcome: 'failed', errorMessage: 'overloaded' }),
    )
    expect(spans[0]!.statusCode).toBe(2)
    expect(spans[0]!.statusMessage).toBe('overloaded')
  })

  it('startTime equals end - durationMs so dashboards reconstruct duration correctly', () => {
    const { mod, spans } = makeFakeOtel()
    const emitter = createEmitter({
      packageName: '@voightxyz/anthropic',
      packageVersion: '0.1.8',
      otelModule: mod,
    })
    emitter!.emit(baseEvent({ durationMs: 250 }))
    const span = spans[0]!
    expect(typeof span.startTime).toBe('number')
    expect(typeof span.endedAt).toBe('number')
    expect((span.endedAt as number) - (span.startTime as number)).toBe(250)
  })

  it("swallows errors thrown from the tracer's startSpan without surfacing them to the caller", () => {
    const { mod, throwOnStartSpan } = makeFakeOtel()
    let observedError: unknown = null
    const emitter = createEmitter({
      packageName: '@voightxyz/anthropic',
      packageVersion: '0.1.8',
      otelModule: mod,
      onLoadError: (err) => {
        observedError = err
      },
    })
    throwOnStartSpan(new Error('synthetic span-create failure'))
    expect(() => emitter!.emit(baseEvent())).not.toThrow()
    expect((observedError as Error)?.message).toBe(
      'synthetic span-create failure',
    )
  })

  it('passes the package name + version through to getTracer', () => {
    const calls: Array<{ name: string; version?: string }> = []
    const { mod: baseMod, spans } = makeFakeOtel()
    const mod: OtelLikeModule = {
      ...baseMod,
      trace: {
        getTracer(name, version) {
          calls.push({ name, version })
          return baseMod.trace.getTracer(name, version)
        },
      },
    }
    const emitter = createEmitter({
      packageName: '@voightxyz/anthropic',
      packageVersion: '0.1.8',
      otelModule: mod,
    })
    emitter!.emit(baseEvent())
    expect(calls).toEqual([
      { name: '@voightxyz/anthropic', version: '0.1.8' },
    ])
    expect(spans).toHaveLength(1)
  })
})
