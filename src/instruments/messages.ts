/**
 * Instrument for `client.messages.create`.
 *
 * Wraps the Anthropic SDK's primary Messages endpoint. Handles both
 * transports:
 *
 *   - Non-streaming: pulls text from `content[].text` blocks, tool
 *     calls from `content[].tool_use` blocks (input is unknown JSON,
 *     we serialise via JSON.stringify so the wire format matches the
 *     openai wrapper's `arguments` string).
 *
 *   - Streaming: a state machine over the event sequence
 *     `message_start` → `content_block_start` → many
 *     `content_block_delta` → `content_block_stop` → `message_delta`
 *     → `message_stop`. We maintain a per-block aggregator keyed by
 *     `index`. Text deltas concatenate `delta.text`. Tool-use deltas
 *     carry `delta.partial_json` fragments that we append to that
 *     block's `arguments` string. The final `message_delta` carries
 *     the output_tokens; the initial `message_start` carries the
 *     input_tokens + the two cache fields.
 *
 * Token surface emitted on `metadata.tokens`:
 *   - input, output, total: always
 *   - cache_read: only when `cache_read_input_tokens > 0`
 *   - cache_creation: only when `cache_creation_input_tokens > 0`
 *
 * Privacy fan-out: identical contract to @voightxyz/openai
 * (`minimal` → tags only, `standard` → scrubbed content,
 * `full` → verbatim). The first tool call's name flows into
 * `toolExecuted` at every level so the audit-log DETAIL column
 * keeps rendering meaningfully even under minimal.
 */

import { randomUUID } from 'node:crypto'

import type { EventPayload, PrivacyLevel } from '../types.js'
import { scrubAnyValue, scrubPii } from '../privacy.js'
import {
  drainTraceLogs,
  getCurrentTrace,
  pushSpanAndRun,
} from '../context.js'

// ─── Loose Anthropic types ────────────────────────────────────────
//
// We model only the surface this instrument actually reads. Keeping
// the types loose insulates us from upstream SDK changes that don't
// affect our wire shape.

interface MessageCreateParams {
  model: string
  max_tokens: number
  messages: Array<Record<string, unknown>>
  stream?: boolean
  [k: string]: unknown
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  [k: string]: unknown
}

interface TextContentBlock {
  type: 'text'
  text: string
}

interface ToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

type ContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | { type: string; [k: string]: unknown }

interface NonStreamingMessage {
  id?: string
  model?: string
  content?: ContentBlock[]
  stop_reason?: string | null
  usage?: AnthropicUsage
  [k: string]: unknown
}

// Streaming events
interface StreamMessageStart {
  type: 'message_start'
  message: NonStreamingMessage
}
interface StreamContentBlockStart {
  type: 'content_block_start'
  index: number
  content_block: ContentBlock
}
interface StreamContentBlockDelta {
  type: 'content_block_delta'
  index: number
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: string; [k: string]: unknown }
}
interface StreamContentBlockStop {
  type: 'content_block_stop'
  index: number
}
interface StreamMessageDelta {
  type: 'message_delta'
  delta: { stop_reason?: string | null; [k: string]: unknown }
  usage?: { output_tokens?: number; [k: string]: unknown }
}
interface StreamMessageStop {
  type: 'message_stop'
}

type StreamEvent =
  | StreamMessageStart
  | StreamContentBlockStart
  | StreamContentBlockDelta
  | StreamContentBlockStop
  | StreamMessageDelta
  | StreamMessageStop
  | { type: string; [k: string]: unknown }

type CreateFn = (
  params: MessageCreateParams,
) => Promise<NonStreamingMessage | AsyncIterable<StreamEvent>>

/**
 * Flat tool-call shape we emit. Mirrors the openai wrapper's
 * `metadata.toolCalls[*]` schema so dashboard rendering doesn't
 * need to know which provider produced the event.
 */
interface CapturedToolCall {
  id: string
  name: string
  arguments: string
}

interface NormalisedTokens {
  input: number
  output: number
  total: number
  cache_read?: number
  cache_creation?: number
}

export interface EventSink {
  send: (event: EventPayload) => void
}

export interface InstrumentContext {
  agentId: string
  privacy: PrivacyLevel
  /**
   * Trace grouping identifier stamped on every emitted event under
   * `metadata.sessionId`. The wrapper resolves it once per instance
   * (explicit option or auto-generated UUID v4).
   */
  sessionId: string
  /** Optional per-wrapper route / endpoint tag stamped on
   *  `metadata.endpoint`. A `withTrace({ routeTag })` boundary at
   *  call time overrides this default. */
  routeTag?: string
  ingest: EventSink
  /** Time source in ms; injected so tests can produce deterministic `durationMs`. */
  now: () => number
}

/**
 * Resolved span context per intercepted call. Mirrors the structure
 * used by `@voightxyz/openai` so the dashboard sees identical
 * span fields across both providers.
 */
interface SpanInfo {
  spanId: string
  parentSpanId?: string
  endpoint?: string
}

function captureSpanInfo(ctx: InstrumentContext): SpanInfo {
  const trace = getCurrentTrace()
  return {
    spanId: randomUUID(),
    parentSpanId: trace?.currentSpanId,
    endpoint: trace?.routeTag ?? ctx.routeTag,
  }
}

export function instrumentMessages(
  original: CreateFn,
  ctx: InstrumentContext,
): CreateFn {
  return async function wrappedCreate(params: MessageCreateParams) {
    const startedAt = ctx.now()
    const isStream = params.stream === true
    const span = captureSpanInfo(ctx)

    if (!isStream) {
      return pushSpanAndRun(span.spanId, async () => {
        let result: NonStreamingMessage
        try {
          result = (await original(params)) as NonStreamingMessage
        } catch (err) {
          ctx.ingest.send(
            buildFailureEvent({ ctx, params, startedAt, error: err, span }),
          )
          throw err
        }
        ctx.ingest.send(
          buildSuccessEvent({ ctx, params, startedAt, response: result, span }),
        )
        return result
      })
    }

    // Streaming — manually maintain currentSpanId for the iterator's
    // lifetime so nested wrapped calls during streaming see this call
    // as their parent. Restoration is finally-safe (success / failure
    // / thrown-from-iterator).
    const trace = getCurrentTrace()
    const previousSpanId = trace?.currentSpanId
    if (trace) trace.currentSpanId = span.spanId

    let result: AsyncIterable<StreamEvent>
    try {
      result = (await original(params)) as AsyncIterable<StreamEvent>
    } catch (err) {
      if (trace) trace.currentSpanId = previousSpanId
      ctx.ingest.send(
        buildFailureEvent({ ctx, params, startedAt, error: err, span }),
      )
      throw err
    }

    return wrapStream(result, ctx, params, startedAt, span, () => {
      if (trace) trace.currentSpanId = previousSpanId
    })
  }
}

// ─── Event builders ──────────────────────────────────────────────

function buildSuccessEvent(args: {
  ctx: InstrumentContext
  params: MessageCreateParams
  startedAt: number
  response: NonStreamingMessage
  span: SpanInfo
}): EventPayload {
  const { ctx, params, startedAt, response, span } = args
  const responseText = extractText(response.content ?? [])
  const toolCalls = extractToolCalls(response.content ?? [])
  const tokens = normaliseTokens(response.usage)
  const durationMs = ctx.now() - startedAt

  return assembleEvent({
    ctx,
    params,
    span,
    durationMs,
    outcome: 'success',
    responseText: responseText.length > 0 ? responseText : undefined,
    tokens,
    toolCalls,
    streaming: false,
    finishReason: response.stop_reason ?? null,
    modelFromResponse: response.model,
  })
}

function buildFailureEvent(args: {
  ctx: InstrumentContext
  params: MessageCreateParams
  startedAt: number
  error: unknown
  span: SpanInfo
}): EventPayload {
  const { ctx, params, startedAt, error, span } = args
  const durationMs = ctx.now() - startedAt
  const message = error instanceof Error ? error.message : String(error)
  return assembleEvent({
    ctx,
    params,
    span,
    durationMs,
    outcome: 'failed',
    streaming: params.stream === true,
    errorMessage: message,
  })
}

function buildStreamEvent(args: {
  ctx: InstrumentContext
  params: MessageCreateParams
  startedAt: number
  aggregatedText: string
  tokens: NormalisedTokens | null
  toolCalls: CapturedToolCall[] | null
  modelFromResponse: string | undefined
  finishReason: string | null
  span: SpanInfo
}): EventPayload {
  return assembleEvent({
    ctx: args.ctx,
    params: args.params,
    span: args.span,
    durationMs: args.ctx.now() - args.startedAt,
    outcome: 'success',
    responseText:
      args.aggregatedText.length > 0 ? args.aggregatedText : undefined,
    tokens: args.tokens,
    toolCalls: args.toolCalls,
    streaming: true,
    finishReason: args.finishReason,
    modelFromResponse: args.modelFromResponse,
  })
}

/**
 * Single assembler — privacy fan-out + payload shape in one place
 * so the three callers above can't drift apart.
 */
function assembleEvent(args: {
  ctx: InstrumentContext
  params: MessageCreateParams
  span: SpanInfo
  durationMs: number
  outcome: 'success' | 'failed'
  responseText?: string | undefined
  tokens?: NormalisedTokens | null
  toolCalls?: CapturedToolCall[] | null
  streaming: boolean
  finishReason?: string | null
  errorMessage?: string
  modelFromResponse?: string | undefined
}): EventPayload {
  const { ctx, params, span, durationMs, outcome, streaming, errorMessage } = args
  const tokens = args.tokens ?? null
  const toolCalls = args.toolCalls ?? null
  const model = args.modelFromResponse ?? params.model

  const metadata: Record<string, unknown> = {
    source: 'anthropic-sdk',
    privacyLevel: ctx.privacy,
    streaming,
    sessionId: ctx.sessionId,
    spanId: span.spanId,
  }
  if (span.parentSpanId) metadata.parentSpanId = span.parentSpanId
  if (span.endpoint) metadata.endpoint = span.endpoint
  // Tags propagate from the active trace frame (set via
  // `withTrace({ tags })`) so the dashboard can filter / aggregate
  // by user / plan / org / any custom dimension the caller supplies.
  const trace = getCurrentTrace()
  if (trace?.tags) metadata.tags = trace.tags
  const drainedLogs = drainTraceLogs()
  if (drainedLogs.length > 0) metadata.logs = drainedLogs
  if (tokens) metadata.tokens = tokens
  if (args.finishReason !== undefined && args.finishReason !== null) {
    metadata.finishReason = args.finishReason
  }

  const firstToolName =
    toolCalls && toolCalls.length > 0 ? toolCalls[0]!.name : undefined

  if (ctx.privacy === 'minimal') {
    return {
      agentId: ctx.agentId,
      type: 'reasoning',
      model,
      durationMs,
      outcome,
      ...(firstToolName ? { toolExecuted: firstToolName } : {}),
      metadata,
      ...(errorMessage ? { errorMessage } : {}),
    }
  }

  const messages =
    ctx.privacy === 'standard'
      ? (scrubAnyValue(params.messages) as MessageCreateParams['messages'])
      : params.messages

  const responseText = args.responseText
  const scrubbedResponse =
    responseText !== undefined
      ? ctx.privacy === 'standard'
        ? scrubPii(responseText)
        : responseText
      : undefined
  if (scrubbedResponse !== undefined) {
    metadata.responseText = scrubbedResponse
  }

  if (toolCalls && toolCalls.length > 0) {
    metadata.toolCalls =
      ctx.privacy === 'standard'
        ? toolCalls.map((t) => ({
            id: t.id,
            name: t.name,
            arguments: scrubPii(t.arguments),
          }))
        : toolCalls
  }

  return {
    agentId: ctx.agentId,
    type: 'reasoning',
    model,
    durationMs,
    outcome,
    ...(firstToolName ? { toolExecuted: firstToolName } : {}),
    input: { messages },
    metadata,
    ...(errorMessage ? { errorMessage } : {}),
  }
}

// ─── Non-streaming helpers ──────────────────────────────────────

function extractText(content: ContentBlock[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'text' && typeof (block as TextContentBlock).text === 'string') {
      out += (block as TextContentBlock).text
    }
  }
  return out
}

function extractToolCalls(content: ContentBlock[]): CapturedToolCall[] | null {
  const out: CapturedToolCall[] = []
  for (const block of content) {
    if (block.type !== 'tool_use') continue
    const t = block as ToolUseContentBlock
    out.push({
      id: typeof t.id === 'string' ? t.id : '',
      name: typeof t.name === 'string' ? t.name : '',
      // Serialise the model's chosen tool input to a JSON string so
      // the wire shape matches openai's `arguments: string` exactly.
      // Anthropic gives us a parsed object; openai gives us the raw
      // string. We normalise here.
      arguments: safeStringify(t.input),
    })
  }
  return out.length > 0 ? out : null
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v ?? {})
  } catch {
    return ''
  }
}

function normaliseTokens(u: AnthropicUsage | undefined): NormalisedTokens | null {
  if (!u) return null
  const input = numberOrZero(u.input_tokens)
  const output = numberOrZero(u.output_tokens)
  const total = input + output
  const cacheRead = numberOrZero(u.cache_read_input_tokens)
  const cacheCreation = numberOrZero(u.cache_creation_input_tokens)
  const base: NormalisedTokens = { input, output, total }
  if (cacheRead > 0) base.cache_read = cacheRead
  if (cacheCreation > 0) base.cache_creation = cacheCreation
  return base
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// ─── Streaming wrapper ──────────────────────────────────────────

/**
 * Mutating accumulator for the streaming state machine. We hold a
 * single source of truth across chunks: text aggregator, per-index
 * tool-call entries, latest usage seen, final stop_reason. The wrap
 * function yields each event to the user untouched and only mutates
 * this struct as bytes pass through.
 */
interface StreamState {
  aggregatedText: string
  toolBlocks: Map<number, CapturedToolCall>
  usage: AnthropicUsage | null
  modelFromResponse: string | undefined
  finishReason: string | null
}

function wrapStream(
  source: AsyncIterable<StreamEvent>,
  ctx: InstrumentContext,
  params: MessageCreateParams,
  startedAt: number,
  span: SpanInfo,
  onComplete: () => void,
): AsyncIterable<StreamEvent> {
  const state: StreamState = {
    aggregatedText: '',
    toolBlocks: new Map(),
    usage: null,
    modelFromResponse: undefined,
    finishReason: null,
  }
  let emitted = false

  function emit() {
    if (emitted) return
    emitted = true
    ctx.ingest.send(
      buildStreamEvent({
        ctx,
        params,
        startedAt,
        aggregatedText: state.aggregatedText,
        tokens: normaliseTokens(state.usage ?? undefined),
        toolCalls: snapshotTools(state.toolBlocks),
        modelFromResponse: state.modelFromResponse,
        finishReason: state.finishReason,
        span,
      }),
    )
  }

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const ev of source) {
          applyEvent(state, ev)
          yield ev
        }
      } catch (err) {
        ctx.ingest.send(
          buildFailureEvent({ ctx, params, startedAt, error: err, span }),
        )
        emitted = true
        throw err
      } finally {
        emit()
        onComplete()
      }
    },
  }
}

/**
 * Step the streaming state machine one event forward. Pure on the
 * `state` argument (mutates it in place). Unknown event types pass
 * through silently — Anthropic adds new event types over time and
 * we don't want a new event class to break capture.
 */
function applyEvent(state: StreamState, ev: StreamEvent): void {
  switch (ev.type) {
    case 'message_start': {
      const e = ev as StreamMessageStart
      if (e.message?.model && !state.modelFromResponse) {
        state.modelFromResponse = e.message.model
      }
      if (e.message?.usage) {
        // message_start carries input_tokens + cache fields. We
        // seed `usage` here so the final tokens object includes
        // cache numbers even if message_delta only overwrites
        // output_tokens.
        state.usage = { ...(state.usage ?? {}), ...e.message.usage }
      }
      return
    }
    case 'content_block_start': {
      const e = ev as StreamContentBlockStart
      if (e.content_block?.type === 'tool_use') {
        const tu = e.content_block as ToolUseContentBlock
        state.toolBlocks.set(e.index, {
          id: typeof tu.id === 'string' ? tu.id : '',
          name: typeof tu.name === 'string' ? tu.name : '',
          arguments: '',
        })
      }
      return
    }
    case 'content_block_delta': {
      const e = ev as StreamContentBlockDelta
      const d = e.delta as { type: string; [k: string]: unknown }
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        state.aggregatedText += d.text
      } else if (
        d.type === 'input_json_delta' &&
        typeof d.partial_json === 'string'
      ) {
        const entry = state.toolBlocks.get(e.index)
        if (entry) entry.arguments += d.partial_json
      }
      return
    }
    case 'message_delta': {
      const e = ev as StreamMessageDelta
      if (e.delta?.stop_reason && state.finishReason === null) {
        state.finishReason = e.delta.stop_reason
      }
      if (e.usage) {
        // message_delta only carries the final output_tokens. Merge,
        // don't replace, so we keep input_tokens + cache fields from
        // message_start.
        state.usage = { ...(state.usage ?? {}), ...e.usage }
      }
      return
    }
    // content_block_stop, message_stop, and unknown future event
    // types pass through without state updates.
  }
}

function snapshotTools(
  acc: Map<number, CapturedToolCall>,
): CapturedToolCall[] | null {
  if (acc.size === 0) return null
  const entries = [...acc.entries()].sort(([a], [b]) => a - b)
  const out = entries.map(([, v]) => v).filter((t) => t.name.length > 0)
  return out.length > 0 ? out : null
}
