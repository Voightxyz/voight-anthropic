/**
 * `wrapAnthropic` — the public entrypoint of @voightxyz/anthropic.
 *
 * Layered `Proxy`: level 0 intercepts the `messages` property,
 * level 1 intercepts the `create` function on it. Everything outside
 * the `client.messages.create` path passes through untouched via
 * `Reflect.get`, so the legacy `completions` namespace, the model
 * list endpoints, batch endpoints, and any future SDK additions
 * keep working with zero special-casing.
 *
 * The proxy is one level shallower than the openai port because
 * Anthropic exposes `messages` at the top level (no intermediate
 * `chat` namespace).
 *
 * Failure modes are intentionally non-fatal — same contract as
 * @voightxyz/openai:
 *
 *   - `enabled: false`         → return the original client.
 *   - no API key resolves      → log a one-line warning and return
 *                                 the original client.
 *
 * Internal `_fetch` and `_env` options exist so tests can drive
 * the network + environment surface without touching globals.
 */

import { randomUUID } from 'node:crypto'

import type { WrapOptions } from './types.js'
import { resolveApiKey, resolveAgent } from './identity.js'
import { createIngestClient } from './ingest.js'
import {
  instrumentMessages,
  type InstrumentContext,
} from './instruments/messages.js'
import { createEmitter, type OtelEmitter } from './otel-emit.js'

// Static version tag passed to OTel's `trace.getTracer(name, version)`.
// Used for telemetry metadata only — span shape is decoupled.
const PACKAGE_VERSION = '0.1.8'

interface InternalOptions extends WrapOptions {
  _fetch?: typeof fetch
  _env?: Record<string, string | undefined>
}

const DEFAULT_API_BASE = 'https://api.voight.xyz'

export function wrapAnthropic<T extends object>(
  client: T,
  options: WrapOptions = {},
): T {
  const opts = options as InternalOptions

  if (opts.enabled === false) return client

  const env = opts._env ?? process.env
  const apiKey = resolveApiKey(
    { voightApiKey: opts.voightApiKey, agent: opts.agent },
    env,
  )

  if (apiKey === null) {
    console.warn(
      '[voight] no VOIGHT_KEY resolved — wrapper is a pass-through. ' +
        'Set process.env.VOIGHT_KEY or pass `voightApiKey` to wrapAnthropic() to enable capture.',
    )
    return client
  }

  const agentId = resolveAgent(
    { voightApiKey: opts.voightApiKey, agent: opts.agent },
    env,
  )

  const ingest = createIngestClient({
    apiBase: opts.apiBase ?? DEFAULT_API_BASE,
    apiKey,
    fetch: opts._fetch,
  })

  // sessionId is generated once per wrapper instance. Explicit
  // override wins so callers can scope by user / conversation /
  // request without us second-guessing them.
  const sessionId =
    typeof opts.sessionId === 'string' && opts.sessionId.trim().length > 0
      ? opts.sessionId.trim()
      : randomUUID()

  const routeTag =
    typeof opts.routeTag === 'string' && opts.routeTag.trim().length > 0
      ? opts.routeTag.trim()
      : undefined

  // Opt-in OpenTelemetry side-channel. When `otel: true`, every
  // captured event is also emitted as a span. We try to load
  // `@opentelemetry/api` lazily; if it's not installed, `createEmitter`
  // returns null and we silently fall back to direct-only ingestion.
  let otelEmitter: OtelEmitter | null = null
  if (opts.otel === true) {
    otelEmitter = createEmitter({
      packageName: '@voightxyz/anthropic',
      packageVersion: PACKAGE_VERSION,
      onLoadError: (err) => {
        console.warn(
          '[voight] otel: true was requested but @opentelemetry/api could not be loaded — wrapper falls back to direct ingestion only.',
          err instanceof Error ? err.message : err,
        )
      },
    })
  }

  const ctx: InstrumentContext = {
    agentId,
    privacy: opts.privacy ?? 'standard',
    sessionId,
    routeTag,
    ingest,
    now: () => Date.now(),
    ...(otelEmitter !== null
      ? { emitOtelSpan: (event) => otelEmitter!.emit(event) }
      : {}),
  }

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'messages') {
        const messages = Reflect.get(target, prop, receiver)
        return wrapMessages(messages as object, ctx)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

function wrapMessages<M extends object>(
  messages: M,
  ctx: InstrumentContext,
): M {
  return new Proxy(messages, {
    get(target, prop, receiver) {
      if (prop === 'create') {
        const original = Reflect.get(target, prop, receiver) as (
          params: never,
        ) => Promise<unknown>
        // .bind so `this` inside the SDK's `create` stays the real
        // messages instance, not the proxy. Without this the
        // Anthropic SDK loses access to its internal http client.
        return instrumentMessages(
          original.bind(target) as never,
          ctx,
        )
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}
