/**
 * Async-context tracking for wrapped LLM calls.
 *
 * The wrapper exposes one optional helper, `withTrace`, that opens a
 * Node.js `AsyncLocalStorage` frame for the duration of a request /
 * handler / job. Inside that frame:
 *
 *   · `log(msg)` lines accumulate on a per-trace buffer. The next
 *     wrapped LLM call drains the buffer into its event under
 *     `metadata.logs`, so the dashboard's Logs sub-tab on the trace
 *     drill-down stays scoped to "what happened around this call".
 *
 *   · Each wrapped LLM call updates the frame's `currentSpanId` so
 *     nested wrapper invocations see the enclosing call as their
 *     `parentSpanId`. The previous value is restored after the call
 *     completes, regardless of success / failure / streaming.
 *
 *   · `routeTag` set via `withTrace({ routeTag })` overrides the
 *     wrapper-instance default, so a per-request endpoint label can
 *     flow without re-wrapping the client per request.
 *
 * Outside `withTrace`, `log()` is a silent no-op and wrapped calls
 * have no parent. That keeps the contract predictable when the
 * helper isn't adopted yet.
 *
 * The store is process-local. Tests reset state implicitly by
 * scoping each case in its own `withTrace` (or by skipping it).
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export type LogLevel = 'info' | 'warn' | 'error'

export interface SpanLog {
  /** ISO-8601 timestamp. */
  ts: string
  level: LogLevel
  message: string
}

export interface TraceFrame {
  /** Per-trace log accumulator. Mutated by `log()` and drained by
   *  each wrapped call when it assembles its event. */
  logs: SpanLog[]
  /** Optional endpoint tag set at the trace boundary. When present,
   *  it wins over the per-wrapper `routeTag` because it's the more
   *  specific signal (the route that triggered this trace). */
  routeTag?: string
  /** Optional key-value tags stamped on `metadata.tags` of every
   *  event emitted in this trace. The canonical use is per-user
   *  spend tracking — pass `{ userId, plan, org, … }` at the
   *  request boundary so the dashboard can filter / aggregate by
   *  any of them. Tags pass through verbatim; redacting / hashing
   *  is the caller's responsibility (matches the `log()` contract). */
  tags?: Record<string, unknown>
  /** Span id of the currently-executing wrapped call inside this
   *  trace, or undefined when no call is in flight. Read by nested
   *  calls to set their `parentSpanId`. */
  currentSpanId?: string
}

const traceStore = new AsyncLocalStorage<TraceFrame>()

/**
 * Open a trace frame for the duration of `fn`. Returns whatever `fn`
 * returns (async or sync). Idempotent under nesting — a nested
 * `withTrace` opens a fresh frame, isolating its logs / spans from
 * the outer one (rare, but legal).
 */
export function withTrace<T>(
  fn: () => Promise<T> | T,
  options: {
    routeTag?: string
    tags?: Record<string, unknown>
  } = {},
): Promise<T> {
  const routeTag =
    typeof options.routeTag === 'string' && options.routeTag.trim().length > 0
      ? options.routeTag.trim()
      : undefined
  // Tags drop to undefined when the caller passes an empty object so
  // the event payload doesn't carry a meaningless `metadata.tags: {}`.
  const tags =
    options.tags &&
    typeof options.tags === 'object' &&
    Object.keys(options.tags).length > 0
      ? options.tags
      : undefined
  const frame: TraceFrame = {
    logs: [],
    routeTag,
    tags,
    currentSpanId: undefined,
  }
  return Promise.resolve(traceStore.run(frame, fn))
}

/** Returns the active trace frame, or undefined when not in one. */
export function getCurrentTrace(): TraceFrame | undefined {
  return traceStore.getStore()
}

/**
 * Mark `spanId` as the currently-executing call for the duration of
 * `fn`, then restore the previous value. Used by the instruments so
 * nested wrapper calls see correct parent IDs. No-op (just runs
 * `fn`) when called outside a `withTrace`.
 */
export async function pushSpanAndRun<T>(
  spanId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const trace = traceStore.getStore()
  if (!trace) return fn()
  const previous = trace.currentSpanId
  trace.currentSpanId = spanId
  try {
    return await fn()
  } finally {
    trace.currentSpanId = previous
  }
}

/**
 * Snapshot + clear the current trace's log buffer. Called by the
 * instruments when assembling an event so the lines accumulated
 * since the last call travel with it. Returns an empty array when
 * not inside a trace.
 */
export function drainTraceLogs(): SpanLog[] {
  const trace = traceStore.getStore()
  if (!trace || trace.logs.length === 0) return []
  const drained = trace.logs.slice()
  trace.logs.length = 0
  return drained
}
