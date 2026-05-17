/**
 * `log()` — public helper for stamping a structured log line on the
 * active trace.
 *
 * Inside a `withTrace(fn)` boundary, each call appends to a buffer
 * that the next wrapped LLM call drains into its `metadata.logs`.
 * The dashboard's Logs sub-tab reads that field, so log lines emitted
 * while preparing a call show up on the trace drill-down beside the
 * span that triggered the network round-trip.
 *
 * Outside `withTrace` the function is a silent no-op: log lines have
 * nowhere stable to land (no session to attach to, no ingest pipe
 * registered), so we drop them rather than buffer globally and risk
 * attaching them to an unrelated future call.
 *
 * Usage:
 *
 *   import { wrapOpenAI, withTrace, log } from '@voightxyz/openai'
 *
 *   const client = wrapOpenAI(new OpenAI(), { agent: 'chatbot' })
 *
 *   app.post('/api/chat', (req, res) =>
 *     withTrace(async () => {
 *       log(`user ${req.body.userId} asked: ${req.body.prompt.slice(0, 80)}…`)
 *       const r = await client.chat.completions.create({ ... })
 *       log('chat completion returned', { level: 'info' })
 *       res.json(r)
 *     }, { routeTag: 'POST /api/chat' })
 *   )
 */

import { getCurrentTrace, type LogLevel } from './context.js'

export type { LogLevel } from './context.js'

export interface LogOptions {
  /** Defaults to `'info'`. */
  level?: LogLevel
}

export function log(message: string, options: LogOptions = {}): void {
  const trace = getCurrentTrace()
  if (!trace) return
  trace.logs.push({
    ts: new Date().toISOString(),
    level: options.level ?? 'info',
    message,
  })
}
