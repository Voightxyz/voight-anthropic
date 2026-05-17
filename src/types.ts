// Public types for @voightxyz/anthropic. Kept in a single file so
// the public surface is auditable at a glance — anything not
// exported from `index.ts` is implementation detail.

/**
 * Capture aggressiveness for prompts and responses.
 *
 * - `minimal`: model, tokens, latency, errors only. Zero content.
 * - `standard` (default): + prompts/responses redacted of common
 *   PII (emails, phone numbers, credit cards, API keys, JWTs).
 * - `full`: everything raw, no redaction.
 */
export type PrivacyLevel = 'minimal' | 'standard' | 'full'

export interface WrapOptions {
  /** Voight API key. Falls back to `process.env.VOIGHT_KEY`. */
  voightApiKey?: string

  /** Voight API base URL. Defaults to `https://api.voight.xyz`. */
  apiBase?: string

  /**
   * Stable agent identifier surfaced in the dashboard. Falls back
   * to `process.env.VOIGHT_AGENT`, then `process.env.HOSTNAME`,
   * then `'unknown-agent'`.
   */
  agent?: string

  /** Default `'standard'`. See {@link PrivacyLevel}. */
  privacy?: PrivacyLevel

  /**
   * Trace grouping identifier. Stamped on `metadata.sessionId` of
   * every event emitted by this wrapper instance, so the dashboard
   * can render related calls (chat turns, multi-step agent runs)
   * as a single trace.
   *
   * When omitted, the wrapper auto-generates a UUID v4 once per
   * `wrapAnthropic()` call and reuses it for the life of the wrapped
   * client. Pass an explicit value to scope a session yourself
   * (per-user, per-conversation, per-request, …).
   */
  sessionId?: string

  /**
   * Application-level route tag stamped on `metadata.endpoint` of
   * every event from this wrapper. Lets the dashboard group calls
   * by user-facing endpoint, cron job, or background worker
   * (`'POST /api/chat'`, `'cron:nightly-rollup'`, …). Static per
   * wrapper instance — instantiate one wrapper per route, or set
   * the value dynamically via `withTrace({ routeTag })`.
   */
  routeTag?: string

  /** Kill switch. When `false` the wrapper is a no-op pass-through. */
  enabled?: boolean
}

/**
 * Wire-format event posted to `POST /v1/events`. Mirrors the schema
 * accepted by the Voight backend (see `apps/api/src/routes/events.ts`
 * in the monorepo). The wrapper only ever populates a subset of
 * these fields, but the type stays wide so future instruments
 * (tool use, streaming partials, embeddings) can extend it without
 * a breaking change here.
 */
export interface EventPayload {
  agentId?: string
  timestamp?: number | string
  type?: 'reasoning' | 'tool' | 'tx' | 'decision' | 'action' | 'error'
  input?: Record<string, unknown>
  reasoning?: string
  toolsConsidered?: string[]
  toolExecuted?: string
  transaction?: string | null
  amount?: { token: string; value: number } | null
  outcome?: 'pending' | 'success' | 'failed'
  durationMs?: number
  errorMessage?: string
  model?: string
  metadata?: Record<string, unknown>
}
