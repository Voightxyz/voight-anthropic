/**
 * OpenTelemetry side-channel for `@voightxyz/anthropic`.
 *
 * When the wrapper is constructed with `otel: true`, every captured
 * event is *also* emitted as an OTel span — in addition to the
 * direct POST to `api.voight.xyz`. Picks up whichever
 * `TracerProvider` is registered in the host process, so callers in
 * OTel-mandated stacks (Langfuse, Phoenix, Datadog, Sentry, or
 * Voight's own `@voightxyz/vercel-ai` exporter) can consume the
 * same data without us having to integrate per-vendor.
 *
 * Design notes:
 *
 * - `@opentelemetry/api` is an **optional** peer dep. We `require`
 *   it lazily inside `createEmitter` so users who don't opt into
 *   `otel: true` never pay the import cost (and never fail install
 *   if the package isn't there).
 *
 * - When the package IS installed, calling `trace.getTracer(...)`
 *   without a registered provider returns a *no-op* tracer per the
 *   OTel spec — spans go nowhere, but no error is thrown. So a
 *   caller who flips `otel: true` without bootstrapping OTel just
 *   gets the direct POST path, no surprises.
 *
 * - Every emitted span carries `voight.source: 'wrapper'` so the
 *   Voight backend's own OTel exporter (`@voightxyz/vercel-ai`) can
 *   dedupe — if a process has both the wrapper AND the exporter
 *   wired in, the exporter skips wrapper-emitted spans so the
 *   dashboard never sees duplicates.
 *
 * Test surface:
 *
 *   - `attributesForEvent(event)` is pure — given a Voight
 *     `EventPayload`, returns the flat `gen_ai.*` + `ai.*`
 *     attribute bag the OTel span will carry. Easy to assert on.
 *   - `createEmitter(opts)` returns the runtime emitter or `null`
 *     when `@opentelemetry/api` couldn't be loaded.
 */

import { createRequire } from 'node:module'

import type { EventPayload } from './types.js'

// ─── Span name + attribute constants ────────────────────────────────

const SPAN_NAME = 'voight.anthropic.messages'

const ATTR = {
  // OTel GenAI semconv (incubating, 2026-05). Primary path consumed
  // by Phoenix / Langfuse / Datadog GenAI views / etc.
  GEN_AI_SYSTEM: 'gen_ai.system',
  GEN_AI_REQUEST_MODEL: 'gen_ai.request.model',
  GEN_AI_USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  GEN_AI_USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS:
    'gen_ai.usage.cache_read_input_tokens',
  GEN_AI_RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  // Vercel AI SDK ai.* attributes — populated as a fallback for tools
  // that key off Vercel's shape (the @voightxyz/vercel-ai exporter
  // does, among others). Keeps shape parity with what a `streamText`
  // call would emit.
  AI_MODEL_ID: 'ai.model.id',
  AI_MODEL_PROVIDER: 'ai.model.provider',
  AI_USAGE_PROMPT_TOKENS: 'ai.usage.promptTokens',
  AI_USAGE_COMPLETION_TOKENS: 'ai.usage.completionTokens',
  AI_USAGE_CACHED_INPUT_TOKENS: 'ai.usage.cachedInputTokens',
  AI_RESPONSE_FINISH_REASON: 'ai.response.finishReason',
  // Voight-specific markers. `voight.source: 'wrapper'` is the
  // signal `@voightxyz/vercel-ai`'s exporter uses to dedupe.
  VOIGHT_SOURCE: 'voight.source',
  VOIGHT_PACKAGE: 'voight.package',
  VOIGHT_AGENT: 'voight.agent',
  VOIGHT_SESSION_ID: 'voight.sessionId',
  VOIGHT_ENDPOINT: 'voight.endpoint',
  VOIGHT_API: 'voight.api',
  VOIGHT_STREAMING: 'voight.streaming',
} as const

// ─── Public helpers ─────────────────────────────────────────────────

export interface OtelEmitter {
  emit(event: EventPayload): void
}

export interface CreateEmitterOptions {
  packageName: '@voightxyz/openai' | '@voightxyz/anthropic'
  packageVersion: string
  /**
   * Optional override for the OTel module — tests inject a fake here
   * so we don't have to install `@opentelemetry/api` at unit-test
   * time. Production callers leave this unset and we `require()`
   * the real module.
   */
  otelModule?: OtelLikeModule
  /**
   * Called if loading or using `@opentelemetry/api` throws. Tests
   * assert on this; in production it logs a one-line warning.
   */
  onLoadError?: (err: unknown) => void
}

/**
 * Build an emitter, or return `null` if `@opentelemetry/api` isn't
 * available. Callers must handle the `null` case by falling back to
 * the direct-only path.
 */
export function createEmitter(opts: CreateEmitterOptions): OtelEmitter | null {
  const mod = opts.otelModule ?? loadOtelModule(opts.onLoadError)
  if (mod === null) return null

  let tracer: OtelLikeTracer
  try {
    tracer = mod.trace.getTracer(opts.packageName, opts.packageVersion)
  } catch (err) {
    opts.onLoadError?.(err)
    return null
  }

  return {
    emit(event) {
      try {
        emitSpanForEvent(event, tracer, mod, opts.packageName)
      } catch (err) {
        // Span emission is best-effort. If it explodes for any
        // reason — broken tracer impl, attribute serialisation, etc.
        // — the direct POST already went out, so we just swallow
        // here instead of breaking the user's hot path.
        opts.onLoadError?.(err)
      }
    },
  }
}

/**
 * Flat attribute bag derived from a Voight `EventPayload`. Exported
 * so unit tests can assert the shape without having to round-trip
 * through a real OTel tracer.
 */
export function attributesForEvent(
  event: EventPayload,
  packageName: '@voightxyz/openai' | '@voightxyz/anthropic',
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {}
  const meta = (event.metadata ?? {}) as Record<string, unknown>
  const tokens = (meta.tokens ?? {}) as Record<string, unknown>

  // Provider system: openai for the OpenAI wrapper, anthropic for
  // the Anthropic wrapper. The dashboards we care about (and the
  // Voight backend itself) read this to bucket events.
  const system = packageName === '@voightxyz/anthropic' ? 'anthropic' : 'openai'
  attrs[ATTR.GEN_AI_SYSTEM] = system
  attrs[ATTR.AI_MODEL_PROVIDER] = system

  // Model id (request side). Preserved verbatim because version
  // suffixes matter for downstream cost lookups.
  if (typeof event.model === 'string' && event.model.length > 0) {
    attrs[ATTR.GEN_AI_REQUEST_MODEL] = event.model
    attrs[ATTR.AI_MODEL_ID] = event.model
  }

  // Token counts. Each subfield is optional; we only set what the
  // upstream provider returned so consumers can distinguish
  // "absent" from "zero".
  const input = numberOr(tokens.input, undefined)
  const output = numberOr(tokens.output, undefined)
  const cacheRead = numberOr(tokens.cache_read, undefined)
  if (input !== undefined) {
    attrs[ATTR.GEN_AI_USAGE_INPUT_TOKENS] = input
    attrs[ATTR.AI_USAGE_PROMPT_TOKENS] = input
  }
  if (output !== undefined) {
    attrs[ATTR.GEN_AI_USAGE_OUTPUT_TOKENS] = output
    attrs[ATTR.AI_USAGE_COMPLETION_TOKENS] = output
  }
  if (cacheRead !== undefined) {
    attrs[ATTR.GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS] = cacheRead
    attrs[ATTR.AI_USAGE_CACHED_INPUT_TOKENS] = cacheRead
  }

  // Finish reason. OTel semconv asks for an array, but a single
  // value is the common case for chat completions; we wrap it in
  // a JSON-encoded array so the attribute type stays a string and
  // travels cleanly through every exporter.
  const finishReason =
    typeof meta.finishReason === 'string' ? meta.finishReason : null
  if (finishReason !== null) {
    attrs[ATTR.GEN_AI_RESPONSE_FINISH_REASONS] = JSON.stringify([finishReason])
    attrs[ATTR.AI_RESPONSE_FINISH_REASON] = finishReason
  }

  // Voight-specific markers. `voight.source: 'wrapper'` is the
  // dedup signal for the `@voightxyz/vercel-ai` exporter — if both
  // this wrapper AND that exporter are wired into the same OTel
  // pipeline, the exporter skips the wrapper's spans so the
  // dashboard never gets duplicates.
  attrs[ATTR.VOIGHT_SOURCE] = 'wrapper'
  attrs[ATTR.VOIGHT_PACKAGE] = packageName
  if (typeof event.agentId === 'string' && event.agentId.length > 0) {
    attrs[ATTR.VOIGHT_AGENT] = event.agentId
  }
  if (
    typeof meta.sessionId === 'string' &&
    (meta.sessionId as string).length > 0
  ) {
    attrs[ATTR.VOIGHT_SESSION_ID] = meta.sessionId as string
  }
  if (
    typeof meta.endpoint === 'string' &&
    (meta.endpoint as string).length > 0
  ) {
    attrs[ATTR.VOIGHT_ENDPOINT] = meta.endpoint as string
  }
  if (typeof meta.api === 'string' && (meta.api as string).length > 0) {
    attrs[ATTR.VOIGHT_API] = meta.api as string
  }
  if (typeof meta.streaming === 'boolean') {
    attrs[ATTR.VOIGHT_STREAMING] = meta.streaming as boolean
  }

  return attrs
}

// ─── Internals ──────────────────────────────────────────────────────

/**
 * Structural shapes for the bits of `@opentelemetry/api` we touch.
 * Lets tests inject a fake without depending on the real package, and
 * lets us call `loadOtelModule` lazily so users who don't enable
 * OTel never trigger the require.
 */
export interface OtelLikeSpan {
  setAttributes(attrs: Record<string, string | number | boolean>): unknown
  setStatus(status: { code: number; message?: string }): unknown
  recordException(err: unknown): unknown
  end(endTime?: number): void
}

export interface OtelLikeTracer {
  startSpan(
    name: string,
    options?: { startTime?: number; attributes?: Record<string, unknown> },
  ): OtelLikeSpan
}

export interface OtelLikeModule {
  trace: { getTracer(name: string, version?: string): OtelLikeTracer }
  SpanStatusCode: { OK: number; ERROR: number; UNSET: number }
}

function loadOtelModule(
  onLoadError?: (err: unknown) => void,
): OtelLikeModule | null {
  // We avoid a static `import '@opentelemetry/api'` so that bundlers
  // don't try to resolve it at build time and so the user's install
  // doesn't fail when the package isn't present (it's an *optional*
  // peer dep).
  //
  // `createRequire(import.meta.url)` works in both CJS and ESM
  // builds of this package — esbuild (via tsup) rewrites
  // `import.meta.url` to the equivalent `__filename` reference in
  // the CJS output, so the same source produces working code in
  // both module systems.
  //
  // The string-concat trick on the specifier keeps static analysis
  // (and bundlers, and IDE jump-to-definition) from following the
  // optional dep at build time.
  const moduleName = ['@opentelemetry', 'api'].join('/')
  try {
    const requireOtel = createRequire(import.meta.url)
    return requireOtel(moduleName) as OtelLikeModule
  } catch (err) {
    onLoadError?.(err)
    return null
  }
}

function emitSpanForEvent(
  event: EventPayload,
  tracer: OtelLikeTracer,
  mod: OtelLikeModule,
  packageName: '@voightxyz/openai' | '@voightxyz/anthropic',
): void {
  const now = Date.now()
  const durationMs = numberOr(event.durationMs, 0) ?? 0
  // Span timing: end is "now"; start is "now - duration". OTel
  // expects ms-since-epoch when we pass numbers (some SDKs accept
  // HrTime tuples too, but ms is the safe lowest common
  // denominator and matches what direct ingestion already records).
  const startTime = Math.max(0, now - Math.round(durationMs))
  const attributes = attributesForEvent(event, packageName)
  const span = tracer.startSpan(SPAN_NAME, { startTime, attributes })
  span.setAttributes(attributes)
  if (event.outcome === 'failed') {
    span.setStatus({
      code: mod.SpanStatusCode.ERROR,
      message: event.errorMessage ?? 'unknown',
    })
  } else {
    // OTel treats UNSET / OK identically for non-error spans;
    // setting OK explicitly makes the intent visible in span
    // viewers that distinguish the two.
    span.setStatus({ code: mod.SpanStatusCode.OK })
  }
  span.end(now)
}

function numberOr<T>(
  value: unknown,
  fallback: T,
): number | T {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return fallback
}
